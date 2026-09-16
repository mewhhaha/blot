// Source-only syntax snapshots for the formatter and editor tooling.
//
// Baba owns lexing and parsing: this module runs the existing Baba-backed
// pipeline (layout elaboration, generated Wasm lexing, Baba CPU island parse,
// compact-CST materialization, lowering, surface elaboration) and bundles the
// intermediate artifacts one source file yields. It never touches the
// workspace graph, never resolves imports, and never instantiates the
// Rust/Wasm semantic compiler, so formatting keeps working while the
// compiler artifact is absent. Anything that needs checked types,
// evaluation, or cross-module facts belongs behind `Compiler`, not here.
//
// Worker locality: `cst` keeps methods and closures, and
// `layoutMap.originalOffset` is a closure as well, so a `SyntaxSnapshot`
// must not cross structured-clone boundaries. A compact transfer
// representation for worker snapshots is later work, not part of this module.

import type { Token } from "../../generated/wasm/mod.ts";
import { type Diagnostic, diagnosticCode } from "../diagnostic.ts";
import { contentId, sourceLineStarts } from "../text/document.ts";
import type { Module } from "./ast.ts";
import { babaRuntime } from "./baba_runtime.ts";
import type { Rule } from "./cursor.ts";
import { elaborateLayout, type LayoutSource } from "./layout.ts";
import { parseConcrete } from "./parse.ts";

/**
 * Revision of the source-only syntax frontend. Every snapshot carries it as
 * `frontendRevision` so the syntax cache can key on it without new I/O.
 *
 * P3 wiring for `SYNTAX_FRONTEND_ID` (P1's `src/text/cache.ts`): this
 * revision alone is not the cache identity, and wiring it here toward the
 * compiler artifact is deliberately not done — reading
 * `generated/compiler/compiler-artifact.json` from `src/syntax` would break
 * the source-only isolation proven by `snapshot_isolation.test.ts` and would
 * fail exactly when formatting must survive (no compiler artifact). P3 must,
 * outside `src/syntax` (for example at language-server startup):
 *
 * 1. Decode `generated/compiler/compiler-artifact.json` with
 *    `decodeCompilerArtifactManifest` from `src/compiler/artifact.ts` and
 *    take `compilerInputsSha256` as the compiler-artifact input identity.
 * 2. Hash `compilerInputsSha256`, the bytes of
 *    `generated/wasm/parser.plan`, and `SYNTAX_SNAPSHOT_FRONTEND_REVISION`
 *    together; that digest becomes `SYNTAX_FRONTEND_ID`.
 * 3. When the compiler artifact is absent, keep formatting alive by using a
 *    documented `"no-compiler-inputs"` sentinel for the compiler component
 *    instead of failing.
 *
 * The compiler hash covers only Rust-side inputs; the Baba plan and this
 * revision cover the TypeScript-side frontend. Combined, syntax-cache keys
 * stay stable across checkouts with identical inputs and distinct otherwise.
 */
export const SYNTAX_SNAPSHOT_FRONTEND_REVISION = "blot-syntax-snapshot/1";

/**
 * Identifies the exact source text a snapshot was built from. The digest is
 * the canonical `contentId` from `src/text/document.ts`, shared with the
 * document store and content caches so one identity names one source text
 * everywhere.
 */
export interface SourceIdentity {
  readonly contentId: string;
}

/**
 * Maps elaborated-layout offsets back to original source offsets for the
 * later printer work. Worker-local: `originalOffset` is a closure over the
 * layout's insertion table and must not cross structured-clone boundaries.
 */
export interface SyntaxLayoutMap {
  readonly elaboratedSource: string;
  readonly continuationHints: LayoutSource["continuationHints"];
  originalOffset(offset: number): number;
}

/** Everything the source-only frontend derives from one source file. */
export interface SyntaxSnapshot {
  readonly identity: SourceIdentity;
  readonly source: string;
  readonly frontendRevision: string;
  readonly lineIndex: readonly number[];
  /** Input token tape over the original source, trivia included. */
  readonly tokens: readonly Token[];
  readonly layoutMap: SyntaxLayoutMap;
  /** Worker-local CST cursor; see the module header. */
  readonly cst: Rule;
  readonly module: Module;
}

export type SyntaxSnapshotResult =
  | { readonly ok: true; readonly snapshot: SyntaxSnapshot }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

type InputTapeResult =
  | { readonly ok: true; readonly tape: readonly Token[] }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * Runs the Baba-backed pipeline over one source file and bundles the
 * artifacts. Acceptance and spans match `parseConcrete` exactly: the
 * snapshot composes it rather than reimplementing any stage, then replays
 * the deterministic layout pass for the exposed map and lexes the original
 * source once more with trivia preserved for the input tape.
 */
export async function snapshotSource(
  source: string,
): Promise<SyntaxSnapshotResult> {
  const parsed = await parseConcrete(source);
  if (!parsed.ok) return parsed;
  const layout = await elaborateLayout(source);
  if (!layout.ok) return layout;
  const tape = await inputTokenTape(source);
  if (!tape.ok) return tape;
  return {
    ok: true,
    snapshot: {
      identity: { contentId: contentId(source) },
      source,
      frontendRevision: SYNTAX_SNAPSHOT_FRONTEND_REVISION,
      lineIndex: sourceLineStarts(source),
      tokens: tape.tape,
      layoutMap: {
        elaboratedSource: layout.layout.source,
        continuationHints: layout.layout.continuationHints,
        originalOffset: layout.layout.originalOffset,
      },
      cst: parsed.cst,
      module: parsed.module,
    },
  };
}

async function inputTokenTape(source: string): Promise<InputTapeResult> {
  const runtime = await babaRuntime();
  const lexed = runtime.wasmLexer.lex(source, { preserveTrivia: true });
  if (lexed.diagnostics.length > 0) {
    return {
      ok: false,
      diagnostics: lexed.diagnostics.map((diagnostic) => ({
        code: diagnosticCode(diagnostic.code),
        message: diagnostic.message,
        span: diagnostic.span,
      })),
    };
  }
  const tape: Token[] = [];
  for (let index = 0; index < lexed.tokenTape.length; index += 1) {
    const token = lexed.tokenTape.token(index);
    if (token === undefined) {
      throw new Error(`Baba omitted input token ${index}.`);
    }
    tape.push(token);
  }
  return { ok: true, tape };
}
