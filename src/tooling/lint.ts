export { lintModule } from "./lint/runner.ts";
export type {
  AstPath,
  LintDiagnostic,
  LintEvidence,
  LintFix,
  LintRule,
  LintRuleContext,
  LintVisitors,
} from "./lint/types.ts";
export { DEFAULT_LINT_RULES } from "./lint/rules.ts";
export {
  applyLintFix,
  validateFixCandidate,
  validateLintDiagnostics,
  validateLintDiagnosticsWithCompiler,
} from "./lint/validation.ts";
export type { LintValidationCompiler } from "./lint/validation.ts";
export {
  diagnosticEvidence,
  findLintCandidate,
  lintCandidateIdentity,
  lintEvidenceFor,
  splitLintDiagnostics,
} from "./lint/staged.ts";
export type {
  LintCandidateIdentity,
  SplitLintDiagnostics,
} from "./lint/staged.ts";
export { ScratchValidationSession } from "./lint/scratch.ts";
export type {
  ScratchCombinedRequest,
  ScratchCompiler,
  ScratchFixRequest,
  ScratchRequest,
} from "./lint/scratch.ts";
