import {
  checkFile,
  checkSource,
  type CheckResult,
} from "../check/mod.ts";

/** Typechecks one resolved program graph using Blot's TypeScript semantics. */
export async function checkProgram(path: string): Promise<CheckResult> {
  return await checkFile(path);
}

/** Typechecks one unsaved root revision while resolving dependencies normally. */
export async function checkProgramSource(
  path: string,
  source: string,
): Promise<CheckResult> {
  return await checkSource(path, source);
}

export type { CheckResult };
