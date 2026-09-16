// src/tooling/formatter.ts
//
// Stable formatter facade over the fixed-cost formatting pipeline.
//
// The pipeline builds a typed formatting IR from ONE syntax snapshot,
// prints it through the document algebra, and validates changed output
// with exactly one output parse. There is no rewrite/reparse fixed
// point: layout decisions compose bottom-up from the grammar and
// lowering contract, and no production helper invokes the frontend.
// Changed output costs at most two frontend invocations (one with a
// matching input snapshot); unchanged output returns without an output
// parse. Validation failure is a typed invariant failure, never
// unvalidated changed text.

import type { Diagnostic } from "../diagnostic.ts";
import { type ConcreteParseResult, parseConcrete } from "../syntax/parse.ts";
import {
  snapshotSource,
  SYNTAX_SNAPSHOT_FRONTEND_REVISION,
  type SyntaxSnapshot,
} from "../syntax/snapshot.ts";
import { lineAtOffset, sourceLineStarts } from "../text/document.ts";
import { buildFormatIr } from "./format/build.ts";
import { FormatterInvariantError } from "./format/errors.ts";
import { assertRepresentationEqual } from "./format/equivalence.ts";
import {
  type PrintLimits,
  resolveFormattingOptions,
  resolveLimits,
  resolveStyle,
} from "./format/options.ts";
import { printIr } from "./format/print.ts";

export { lineAtOffset, sourceLineStarts };

export type FormatResult =
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export type FormatSnapshotInput =
  | Extract<ConcreteParseResult, { readonly ok: true }>
  | SyntaxSnapshot;

export type FormatLoopHelper =
  | "statement"
  | "array"
  | "tuple"
  | "lambda"
  | "none";

export interface FormatLoopIteration {
  readonly iteration: number;
  readonly helper: FormatLoopHelper;
}

export interface FormatPhaseMetrics {
  readonly horizontalSpacingChanged: boolean;
  readonly redundantParenSpans: number;
  readonly parenRemovalChanged: boolean;
  readonly loopIterations: number;
  readonly loopHelpers: readonly FormatLoopHelper[];
  readonly structuralIndentationAccepted: boolean;
  readonly finalValidationPassed: boolean;
}

// Observation hooks for characterization tests. Hooks must not throw and
// must not mutate their arguments; formatting output never depends on them.
// Hooks fire only while formatting proceeds past the initial parse, and
// onComplete fires once per successful format. The fixed pipeline runs no
// trial loop, so onLoopIteration never fires and the loop metrics stay
// empty; redundantParenSpans counts compositional grouping removals.
export interface FormatMetricsHooks {
  readonly onLoopIteration?: (iteration: FormatLoopIteration) => void;
  readonly onComplete?: (metrics: FormatPhaseMetrics) => void;
}

/**
 * Optional pipeline controls. Formatting options are parsed and
 * validated so misconfigured clients fail loudly, but the house style
 * is fixed and preferences never override it (see format/options.ts).
 * Limits bound input size, node count, depth, and output bytes; input
 * beyond them is refused with a typed failure.
 */
export interface FormatControls {
  readonly options?: unknown;
  readonly limits?: Partial<PrintLimits>;
}

/**
 * Applies Blot's deliberately small house style: two-space structural
 * indentation, no trailing whitespace, LF line endings, and one final newline.
 * Non-whitespace source content is retained, so comments never need a second
 * lexer and cannot be dropped by printing from the elaborated AST.
 */
export async function formatSource(
  source: string,
  snapshot?: FormatSnapshotInput,
  hooks?: FormatMetricsHooks,
  controls?: FormatControls,
): Promise<FormatResult> {
  const style = resolveStyle(
    resolveFormattingOptions(controls?.options),
  );
  const limits = resolveLimits(controls?.limits);
  const input = await resolveInput(source, snapshot);
  if (!input.ok) return input;
  const ir = buildFormatIr({
    source,
    lineStarts: input.snapshot.lineIndex,
    cst: input.snapshot.cst,
    tokens: input.snapshot.tokens,
    limits,
  });
  const printed = printIr({ ir, width: style.width, limits });
  if (printed.text !== source) {
    const validated = await parseConcrete(printed.text);
    if (!validated.ok) {
      throw new FormatterInvariantError(
        `formatter printed invalid output: ${
          describeDiagnostics(validated.diagnostics)
        }`,
      );
    }
    assertRepresentationEqual(input.snapshot.module, validated.module);
  }
  if (hooks?.onComplete !== undefined) {
    hooks.onComplete({
      horizontalSpacingChanged: printed.stats.spacingChanged,
      redundantParenSpans: printed.stats.groupingDrops,
      parenRemovalChanged: printed.stats.dropsApplied,
      loopIterations: 0,
      loopHelpers: [],
      structuralIndentationAccepted: !printed.stats.usedFallback,
      finalValidationPassed: true,
    });
  }
  return { ok: true, source: printed.text };
}

type ResolvedInput =
  | { readonly ok: true; readonly snapshot: SyntaxSnapshot }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * Resolves the input snapshot. A matching syntax snapshot is reused
 * without invoking the frontend; anything else (no snapshot, a stale
 * snapshot, or a detached parse result without a token tape) parses
 * fresh exactly once.
 */
async function resolveInput(
  source: string,
  snapshot: FormatSnapshotInput | undefined,
): Promise<ResolvedInput> {
  if (snapshot !== undefined && isSyntaxSnapshot(snapshot)) {
    if (
      snapshot.source === source &&
      snapshot.frontendRevision === SYNTAX_SNAPSHOT_FRONTEND_REVISION
    ) {
      return { ok: true, snapshot };
    }
  }
  return await snapshotSource(source);
}

function isSyntaxSnapshot(
  snapshot: FormatSnapshotInput,
): snapshot is SyntaxSnapshot {
  return "frontendRevision" in snapshot;
}

function describeDiagnostics(diagnostics: readonly Diagnostic[]): string {
  const codes = diagnostics.map((diagnostic) => diagnostic.code);
  return codes.join(", ");
}
