export {
  type CheckedModule,
  Compiler,
  type CompilerAnalysis,
  type CompilerArtifact,
  type CompilerExplanation,
  type CompilerHost,
  type CompilerOptions,
  type CompilerSyntaxSnapshot,
  type EvaluatedModule,
  explanationAt,
} from "./compiler/session.ts";
export {
  CompilerInvariantFailure,
  CompilerLimitDiagnostic,
  type CompilerTargetPolicy,
  CompilerTargetRefusal,
  defaultCompilerTargetPolicy,
} from "./compiler/policy.ts";
