export {
  type CheckedModule,
  Compiler,
  type CompilerAnalysis,
  type CompilerArtifact,
  type CompilerHost,
  type CompilerOptions,
  type CompilerSyntaxSnapshot,
  type EvaluatedModule,
} from "./compiler/session.ts";
export {
  CompilerInvariantFailure,
  CompilerLimitDiagnostic,
  type CompilerTargetPolicy,
  CompilerTargetRefusal,
  defaultCompilerTargetPolicy,
} from "./compiler/policy.ts";
