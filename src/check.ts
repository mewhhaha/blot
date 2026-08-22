import { type CheckedModule, Compiler } from "./compiler.ts";

let sharedCompiler: Promise<Compiler> | undefined;

function compiler(): Promise<Compiler> {
  if (sharedCompiler === undefined) sharedCompiler = Compiler.create();
  return sharedCompiler;
}

export async function checkFile(path: string): Promise<CheckedModule> {
  return await (await compiler()).check(path);
}

export async function checkSource(
  path: string,
  source: string,
): Promise<CheckedModule> {
  return await (await compiler()).checkSource(path, source);
}

export type { CheckedModule };
