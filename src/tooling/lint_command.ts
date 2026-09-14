import type { CheckedModule, Compiler } from "../compiler.ts";
import { compareCodeUnits } from "../text_order.ts";
import type { LintDiagnostic, LintFix } from "./lint.ts";
import { lintEditsOverlap } from "./lint/edits.ts";
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
  options: { readonly rule?: string } = {},
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
    const fixes = selectNonOverlappingFixes(
      revision.diagnostics.filter((diagnostic) =>
        options.rule === undefined || diagnostic.code === options.rule
      ),
    );
    if (fixes.length === 0) {
      return {
        source: current,
        diagnostics: revision.diagnostics,
        appliedFixes,
      };
    }
    let selected = fixes;
    try {
      current = await applyFixTransaction(
        compilers.validation,
        path,
        revision,
        selected,
      );
    } catch (error) {
      if (
        !(error instanceof LintFixTransactionError) || selected.length === 1
      ) throw error;
      // Nonoverlapping edits may still depend on the same scope. Commit one
      // validated fix and discover the remaining suggestions on its revision.
      selected = [selected[0]];
      current = await applyFixTransaction(
        compilers.validation,
        path,
        revision,
        selected,
      );
    }
    appliedFixes += selected.length;
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
      return compareCodeUnits(left.code, right.code);
    }),
    checked: {
      type: analysis.type,
      effects: analysis.effects,
      interfaceKey: analysis.interfaceKey,
    },
  };
}

function selectNonOverlappingFixes(
  diagnostics: readonly LintDiagnostic[],
): readonly SelectedFix[] {
  const candidates: SelectedFix[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.fix === null || diagnostic.fix.kind !== "quickfix") continue;
    candidates.push({ diagnostic, fix: diagnostic.fix });
  }
  candidates.sort((left, right) => {
    const leftLength = left.fix.edits.reduce(
      (length, edit) => length + edit.span.end - edit.span.start,
      0,
    );
    const rightLength = right.fix.edits.reduce(
      (length, edit) => length + edit.span.end - edit.span.start,
      0,
    );
    if (leftLength !== rightLength) return leftLength - rightLength;
    if (left.fix.edits[0].span.start !== right.fix.edits[0].span.start) {
      return left.fix.edits[0].span.start - right.fix.edits[0].span.start;
    }
    return compareCodeUnits(left.diagnostic.code, right.diagnostic.code);
  });

  const selected: SelectedFix[] = [];
  for (const candidate of candidates) {
    if (
      selected.some((existing) =>
        existing.fix.edits.some((left) =>
          candidate.fix.edits.some((right) => lintEditsOverlap(left, right))
        )
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
  const first = fixes[0];
  if (first === undefined) return revision.source;
  const combined: LintFix = {
    title: "Apply safe lint fixes",
    kind: "quickfix",
    validation: "check-interface",
    edits: fixes.flatMap((selected) => selected.fix.edits),
  };
  const replacement = applyLintFix(revision.source, combined);
  let next: CheckedModule;
  try {
    next = await compiler.checkSource(path, replacement);
  } catch (error) {
    if (!isCompilerSourceRejection(error)) throw error;
    throw new LintFixTransactionError(
      first.diagnostic,
      combined,
      "did not pass compiler checking",
      error,
    );
  }
  if (
    fixes.some((selected) => selected.fix.validation === "check-interface") &&
    next.interfaceKey !== revision.checked.interfaceKey
  ) {
    throw new LintFixTransactionError(
      first.diagnostic,
      combined,
      `changed the interface from ${revision.checked.type}${revision.checked.effects} to ${next.type}${next.effects}`,
    );
  }
  return replacement;
}
