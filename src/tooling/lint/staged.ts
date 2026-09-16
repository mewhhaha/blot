import { DEFAULT_LINT_RULES } from "./rules.ts";
import type { LintDiagnostic, LintEvidence, LintRule } from "./types.ts";

/**
 * The identity of one fix candidate within its source revision. Detection is
 * deterministic for identical source, so a resolve request can re-detect and
 * match the selected candidate by rule code plus this identity instead of
 * trusting caller-supplied edits.
 */
export interface LintCandidateIdentity {
  readonly start: number;
  readonly end: number;
  readonly title: string;
}

export interface SplitLintDiagnostics {
  /**
   * Diagnostics whose claims are established by current syntax or semantic
   * facts. These publish without constructing or checking any fix, including
   * rewrite-evidence diagnostics that carry no fix: with no proposed rewrite
   * there is nothing to validate.
   */
  readonly publishable: readonly LintDiagnostic[];
  /**
   * Diagnostics whose claims depend on validating a proposed rewrite. These
   * stay unpublished until the lower-priority validation stage proves them.
   */
  readonly rewriteCandidates: readonly LintDiagnostic[];
}

/** Reads one rule code's required evidence from the given rule set. */
export function lintEvidenceFor(
  code: string,
  rules: readonly LintRule[] = DEFAULT_LINT_RULES,
): LintEvidence | null {
  for (const rule of rules) {
    if (rule.code === code) return rule.evidence;
  }
  return null;
}

/**
 * Reads one diagnostic's required evidence. Codes outside the rule set (test
 * doubles, out-of-tree rules) fall back to their fix obligation: a missing
 * or parse-level fix needs no semantic proof, while a check-level fix keeps
 * the historical behavior of proving itself before publication.
 */
export function diagnosticEvidence(
  diagnostic: LintDiagnostic,
  rules: readonly LintRule[] = DEFAULT_LINT_RULES,
): LintEvidence {
  const tagged = lintEvidenceFor(diagnostic.code, rules);
  if (tagged !== null) return tagged;
  if (diagnostic.fix === null || diagnostic.fix.validation === "parse") {
    return "syntax-only";
  }
  return "rewrite-validation";
}

/**
 * Splits detection output into immediately publishable diagnostics and
 * rewrite-validation candidates. Detection plus this split performs zero
 * compiler jobs: ordinary detection never compiles a speculative fix because
 * suggestions exist.
 */
export function splitLintDiagnostics(
  diagnostics: readonly LintDiagnostic[],
  rules: readonly LintRule[] = DEFAULT_LINT_RULES,
): SplitLintDiagnostics {
  const publishable: LintDiagnostic[] = [];
  const rewriteCandidates: LintDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (
      diagnostic.fix !== null &&
      diagnosticEvidence(diagnostic, rules) === "rewrite-validation"
    ) {
      rewriteCandidates.push(diagnostic);
      continue;
    }
    publishable.push(diagnostic);
  }
  return { publishable, rewriteCandidates };
}

/**
 * Reads one diagnostic's fix-candidate identity, or null when it carries no
 * fix. The span plus the fix title identifies the candidate within its
 * revision: two candidates for the same span with the same title are the
 * same rewrite.
 */
export function lintCandidateIdentity(
  diagnostic: LintDiagnostic,
): LintCandidateIdentity | null {
  if (diagnostic.fix === null) return null;
  return {
    start: diagnostic.span.start,
    end: diagnostic.span.end,
    title: diagnostic.fix.title,
  };
}

/**
 * Finds the re-detected candidate matching one resolve identity. Returns
 * null when the candidate no longer exists on the current revision, in which
 * case resolve returns no edits rather than validating a stranger.
 */
export function findLintCandidate(
  diagnostics: readonly LintDiagnostic[],
  rule: string,
  candidate: LintCandidateIdentity,
): LintDiagnostic | null {
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== rule) continue;
    if (
      diagnostic.span.start !== candidate.start ||
      diagnostic.span.end !== candidate.end
    ) continue;
    if (diagnostic.fix === null) continue;
    if (diagnostic.fix.title !== candidate.title) continue;
    return diagnostic;
  }
  return null;
}
