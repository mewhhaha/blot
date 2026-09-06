import {
  CompilerInvariantFailure,
  CompilerLimitDiagnostic,
  CompilerTargetRefusal,
} from "../compiler/policy.ts";
import { BlotError, render } from "../diagnostic.ts";
import { LoadError } from "../load.ts";

/** Render the compiler's classification; never infer a source span from an error. */
export function renderFailure(path: string, error: unknown): string {
  if (error instanceof LoadError) return error.message;
  if (error instanceof BlotError && error.origin !== null) {
    return render(error.origin.path, error.origin.source, error.diagnostic);
  }
  if (error instanceof CompilerTargetRefusal) {
    return `${path}: target refusal [${error.code}]: ${error.message}`;
  }
  if (error instanceof CompilerLimitDiagnostic) {
    return `${path}: compiler limit [${error.code}]: ${error.message}`;
  }
  if (error instanceof CompilerInvariantFailure) {
    return `${path}: compiler invariant failure [${error.code}]: ${error.message}`;
  }
  let message = String(error);
  if (error instanceof Error) message = error.message;
  return `${path}: ${message}`;
}
