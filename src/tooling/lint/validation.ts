import { type CheckedModule, Compiler } from "../../compiler.ts";
import { BlotError } from "../../diagnostic.ts";
import { LoadError } from "../../load.ts";
import { parse } from "../../syntax/parse.ts";
import type { LintDiagnostic, LintFix } from "./types.ts";

export function applyLintFix(source: string, fix: LintFix): string {
  return source.slice(0, fix.span.start) + fix.replacement +
    source.slice(fix.span.end);
}

export async function validateLintDiagnostics(
  path: string,
  source: string,
  diagnostics: readonly LintDiagnostic[],
): Promise<readonly LintDiagnostic[]> {
  const syntaxValidated = await validateSyntaxFixes(source, diagnostics);
  if (!hasSemanticFix(syntaxValidated)) return syntaxValidated;

  const compiler = await Compiler.create();
  try {
    return await validateSemanticLintDiagnostics(
      compiler,
      path,
      source,
      syntaxValidated,
    );
  } finally {
    compiler.destroy();
  }
}

export async function validateLintDiagnosticsWithCompiler(
  compiler: Compiler,
  path: string,
  source: string,
  diagnostics: readonly LintDiagnostic[],
): Promise<readonly LintDiagnostic[]> {
  const candidates = await validateSyntaxFixes(source, diagnostics);
  return await validateSemanticLintDiagnostics(
    compiler,
    path,
    source,
    candidates,
  );
}

async function validateSemanticLintDiagnostics(
  compiler: Compiler,
  path: string,
  source: string,
  candidates: readonly LintDiagnostic[],
): Promise<readonly LintDiagnostic[]> {
  if (!hasSemanticFix(candidates)) return candidates;

  let original: CheckedModule;
  try {
    original = await compiler.checkSource(path, source);
  } catch (error) {
    if (!isCompilerSourceRejection(error)) throw error;
    return candidates.filter((diagnostic) =>
      diagnostic.fix === null || diagnostic.fix.validation === "parse"
    );
  }

  const validated: LintDiagnostic[] = [];
  for (const diagnostic of candidates) {
    const fix = diagnostic.fix;
    if (fix === null || fix.validation === "parse") {
      validated.push(diagnostic);
      continue;
    }
    try {
      const checked = await compiler.checkSource(
        path,
        applyLintFix(source, fix),
      );
      if (
        fix.validation === "check" ||
        (
          checked.type === original.type &&
          checked.effects === original.effects
        )
      ) {
        validated.push(diagnostic);
      }
    } catch (error) {
      if (!isCompilerSourceRejection(error)) throw error;
    }
  }
  return validated;
}

async function validateSyntaxFixes(
  source: string,
  diagnostics: readonly LintDiagnostic[],
): Promise<readonly LintDiagnostic[]> {
  const validated: LintDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.fix === null) {
      validated.push(diagnostic);
      continue;
    }
    if ((await parse(applyLintFix(source, diagnostic.fix))).ok) {
      validated.push(diagnostic);
    }
  }
  return validated;
}

function hasSemanticFix(diagnostics: readonly LintDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) =>
    diagnostic.fix !== null && diagnostic.fix.validation !== "parse"
  );
}

export function isCompilerSourceRejection(error: unknown): boolean {
  return error instanceof BlotError || error instanceof LoadError;
}
