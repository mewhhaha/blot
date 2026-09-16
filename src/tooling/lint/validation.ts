import { type CheckedModule, Compiler } from "../../compiler.ts";
import { BlotError } from "../../diagnostic.ts";
import { LoadError } from "../../load.ts";
import { parse } from "../../syntax/parse.ts";
import type { LintDiagnostic, LintFix } from "./types.ts";
import { applyLintFix } from "./edits.ts";

export { applyLintFix } from "./edits.ts";

/**
 * The compiler surface behind semantic lint-fix validation: checking the
 * original and fixed sources. `Compiler` satisfies this; callers with a
 * long-lived validation compiler pass it instead of minting one per call.
 */
export interface LintValidationCompiler {
  checkSource(path: string, source: string): Promise<CheckedModule>;
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
  compiler: LintValidationCompiler,
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
  compiler: LintValidationCompiler,
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
    if (
      await validateFixCandidate(
        compiler,
        path,
        source,
        original.interfaceKey,
        fix,
      )
    ) {
      validated.push(diagnostic);
    }
  }
  return validated;
}

/**
 * Validates one proposed rewrite against its own proof obligation, the same
 * obligation the batch path enforces per fix: a `parse` fix must produce
 * accepted syntax, a `check` fix must compile, and a `check-interface` fix
 * must compile to the original interface key. Structured source rejections
 * of the candidate read as unproven (false); infrastructure failures throw.
 */
export async function validateFixCandidate(
  compiler: LintValidationCompiler,
  path: string,
  source: string,
  originalInterfaceKey: string,
  fix: LintFix,
): Promise<boolean> {
  const candidate = applyLintFix(source, fix);
  if (fix.validation === "parse") return (await parse(candidate)).ok;
  try {
    const checked = await compiler.checkSource(path, candidate);
    if (fix.validation === "check") return true;
    return checked.interfaceKey === originalInterfaceKey;
  } catch (error) {
    if (!isCompilerSourceRejection(error)) throw error;
    return false;
  }
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
