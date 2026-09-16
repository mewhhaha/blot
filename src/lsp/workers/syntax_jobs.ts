// Lightweight syntax jobs: no Compiler, safe on any worker.
//
// cpu/probe burns deterministic synchronous CPU so tests can prove real work
// ran inside a worker thread in each runtime. syntax/parse-facts runs the
// Baba frontend (owned by Baba, never reimplemented here) and reports plain
// facts. Neither job touches semantic state, so the syntax worker stays
// Compiler-free.

import { parse } from "../../syntax/parse.ts";
import { snapshotSource } from "../../syntax/snapshot.ts";
import type { Range } from "../../text/document.ts";
import {
  assertEditReconstructs,
  deriveEdit,
} from "../../tooling/format/edits.ts";
import { formatSource } from "../../tooling/formatter.ts";
import { paramsObject, requireFormattingOptions } from "./params.ts";
import type { LspWorkerJob } from "./protocol.ts";

/** Executes the Compiler-free job kinds, rejecting everything else. */
export function executeSyntaxJob(
  job: LspWorkerJob,
): Promise<unknown> | unknown {
  switch (job.kind) {
    case "cpu/probe":
      return runCpuProbe(job.iterations, job.seed);
    case "syntax/parse-facts":
      return parseFacts(job.uri, job.source);
    case "syntax/format":
      return formatFacts(job.source, job.params);
    default:
      throw new Error(`syntax jobs cannot execute ${job.kind}`);
  }
}

/** The deterministic cpu/probe answer. */
export interface CpuProbeValue {
  readonly digest: string;
  readonly iterations: number;
  readonly seed: number;
}

/**
 * Burns synchronous CPU deterministically: an FNV-1a stream over iterations
 * mixed with the seed. Bitwise Math.imul arithmetic is exact in every
 * runtime, so the digest agrees between Deno, Node, and in-process runs.
 */
export function runCpuProbe(
  iterations: number,
  seed: number,
): CpuProbeValue {
  let hash = 0x811c9dc5;
  hash ^= seed & 0xffffffff;
  hash >>>= 0;
  for (let index = 0; index < iterations; index += 1) {
    hash ^= (index + seed) & 0xffffffff;
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  const digest = hash.toString(16).padStart(8, "0");
  return { digest, iterations, seed };
}

/** The plain syntax facts for one source text. */
export interface ParseFactsValue {
  readonly uri: string;
  readonly ok: boolean;
  readonly errors: readonly {
    readonly code: string;
    readonly message: string;
    readonly start: number;
    readonly end: number;
  }[];
  readonly declarationCount: number;
  readonly sourceLength: number;
}

/** Parses one source through the Baba frontend and reports plain facts. */
export async function parseFacts(
  uri: string,
  source: string,
): Promise<ParseFactsValue> {
  const parsed = await parse(source);
  if (!parsed.ok) {
    return {
      uri,
      ok: false,
      errors: parsed.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        start: diagnostic.span.start,
        end: diagnostic.span.end,
      })),
      declarationCount: 0,
      sourceLength: source.length,
    };
  }
  return {
    uri,
    ok: true,
    errors: [],
    declarationCount: parsed.module.declarations.length,
    sourceLength: source.length,
  };
}

/** One formatting edit, shaped exactly like the service answer. */
export interface FormatEdit {
  readonly range: Range;
  readonly newText: string;
}

/**
 * Formats one source text without a service replica: the same snapshot,
 * format, and minimal-edit pipeline the service runs, with the same empty
 * answers for invalid or unchanged input. Operational failures propagate
 * so the lane settles an explicit backend failure.
 */
export async function formatFacts(
  source: string,
  params: unknown,
): Promise<readonly FormatEdit[]> {
  const method = "textDocument/formatting";
  const options = requireFormattingOptions(
    paramsObject(params, method),
    method,
  );
  const snapshot = await snapshotSource(source);
  if (!snapshot.ok) return [];
  const formatted = await formatSource(source, snapshot.snapshot, undefined, {
    options,
  });
  if (!formatted.ok || formatted.source === source) return [];
  const edit = deriveEdit(source, formatted.source);
  if (edit === null) return [];
  assertEditReconstructs(source, formatted.source, edit);
  return [{ range: edit.range, newText: edit.newText }];
}
