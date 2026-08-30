import { type CheckedModule, Compiler } from "../compiler.ts";
import type { LintDiagnostic, LintFix } from "./lint.ts";
import { DEFAULT_LINT_RULES, lintModule } from "./lint.ts";
import {
  applyLintFix,
  isCompilerSourceRejection,
  validateLintDiagnosticsWithCompiler,
} from "./lint/validation.ts";

export type LintMode = "report" | "check" | "fix";

export type ParsedLintArguments =
  | {
    readonly ok: true;
    readonly mode: LintMode;
    readonly paths: readonly string[];
  }
  | { readonly ok: false; readonly message: string };

export interface LintedSource {
  readonly source: string;
  readonly diagnostics: readonly LintDiagnostic[];
  readonly appliedFixes: number;
}

export interface LintCompilers {
  readonly analysis: Compiler;
  readonly validation: Compiler;
}

interface LintRevision {
  readonly source: string;
  readonly diagnostics: readonly LintDiagnostic[];
  readonly checked: CheckedModule;
}

interface SelectedFix {
  readonly diagnostic: LintDiagnostic;
  readonly fix: LintFix;
}

class LintFixTransactionError extends Error {
  constructor(
    diagnostic: LintDiagnostic,
    fix: LintFix,
    reason: string,
    cause?: unknown,
  ) {
    super(
      `${diagnostic.code} fix ${JSON.stringify(fix.title)} ${reason}`,
      { cause },
    );
    this.name = "LintFixTransactionError";
  }
}

export function parseLintArguments(
  arguments_: readonly string[],
): ParsedLintArguments {
  let check = false;
  let fix = false;
  const paths: string[] = [];
  for (const argument of arguments_) {
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--fix") {
      fix = true;
      continue;
    }
    if (argument.startsWith("-")) {
      return {
        ok: false,
        message: `blot lint does not recognize option ${
          JSON.stringify(argument)
        }`,
      };
    }
    paths.push(argument);
  }
  if (check && fix) {
    return {
      ok: false,
      message: "blot lint accepts either --check or --fix, not both",
    };
  }
  if (paths.length === 0) {
    return {
      ok: false,
      message: "blot lint requires at least one .blot file",
    };
  }
  let mode: LintMode = "report";
  if (check) mode = "check";
  if (fix) mode = "fix";
  return { ok: true, mode, paths };
}

export async function lintSource(
  compilers: LintCompilers,
  path: string,
  source: string,
): Promise<LintedSource> {
  const revision = await lintRevision(
    compilers,
    path,
    source,
  );
  return {
    source,
    diagnostics: revision.diagnostics,
    appliedFixes: 0,
  };
}

export async function fixLintSource(
  compilers: LintCompilers,
  path: string,
  source: string,
): Promise<LintedSource> {
  let current = source;
  let appliedFixes = 0;
  const revisions = new Set([source]);
  while (true) {
    const revision = await lintRevision(
      compilers,
      path,
      current,
    );
    const fixes = selectNonOverlappingFixes(revision.diagnostics);
    if (fixes.length === 0) {
      return {
        source: current,
        diagnostics: revision.diagnostics,
        appliedFixes,
      };
    }
    current = await applyFixTransaction(
      compilers.validation,
      path,
      revision,
      fixes,
    );
    appliedFixes += fixes.length;
    if (revisions.has(current)) {
      throw new Error(
        `lint fixes repeated a prior source revision after ${appliedFixes} fixes`,
      );
    }
    revisions.add(current);
  }
}

async function lintRevision(
  compilers: LintCompilers,
  path: string,
  source: string,
): Promise<LintRevision> {
  const analysis = await compilers.analysis.analyzeSource(path, source);
  const syntax = await compilers.analysis.syntaxSnapshot(path, source);
  const diagnostics = lintModule(
    syntax.module,
    source,
    syntax.cst,
    DEFAULT_LINT_RULES,
    {
      specializations: analysis.specializations,
      simplifications: analysis.simplifications,
      readability: analysis.readability,
    },
  );
  const validated = await validateLintDiagnosticsWithCompiler(
    compilers.validation,
    path,
    source,
    diagnostics,
  );
  return {
    source,
    diagnostics: validated.toSorted((left, right) => {
      if (left.span.start !== right.span.start) {
        return left.span.start - right.span.start;
      }
      return left.code.localeCompare(right.code);
    }),
    checked: { type: analysis.type, effects: analysis.effects },
  };
}

function selectNonOverlappingFixes(
  diagnostics: readonly LintDiagnostic[],
): readonly SelectedFix[] {
  const candidates: SelectedFix[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.fix === null) continue;
    candidates.push({ diagnostic, fix: diagnostic.fix });
  }
  candidates.sort((left, right) => {
    const leftLength = left.fix.span.end - left.fix.span.start;
    const rightLength = right.fix.span.end - right.fix.span.start;
    if (leftLength !== rightLength) return leftLength - rightLength;
    if (left.fix.span.start !== right.fix.span.start) {
      return left.fix.span.start - right.fix.span.start;
    }
    return left.diagnostic.code.localeCompare(right.diagnostic.code);
  });

  const selected: SelectedFix[] = [];
  for (const candidate of candidates) {
    if (
      selected.some((existing) =>
        spansOverlap(existing.fix.span, candidate.fix.span)
      )
    ) {
      continue;
    }
    selected.push(candidate);
  }
  return selected;
}

async function applyFixTransaction(
  compiler: Compiler,
  path: string,
  revision: LintRevision,
  fixes: readonly SelectedFix[],
): Promise<string> {
  let source = revision.source;
  let checked = revision.checked;
  const descending = fixes.toSorted((left, right) =>
    right.fix.span.start - left.fix.span.start
  );
  for (const selected of descending) {
    const replacement = applyLintFix(source, selected.fix);
    let next: CheckedModule;
    try {
      next = await compiler.checkSource(path, replacement);
    } catch (error) {
      if (!isCompilerSourceRejection(error)) throw error;
      throw new LintFixTransactionError(
        selected.diagnostic,
        selected.fix,
        "did not pass compiler checking",
        error,
      );
    }
    if (
      selected.fix.validation === "check-interface" &&
      (next.type !== checked.type || next.effects !== checked.effects)
    ) {
      throw new LintFixTransactionError(
        selected.diagnostic,
        selected.fix,
        `changed the interface from ${checked.type}${checked.effects} to ${next.type}${next.effects}`,
      );
    }
    source = replacement;
    checked = next;
  }
  return source;
}

function spansOverlap(
  left: { readonly start: number; readonly end: number },
  right: { readonly start: number; readonly end: number },
): boolean {
  return left.start < right.end && right.start < left.end;
}
