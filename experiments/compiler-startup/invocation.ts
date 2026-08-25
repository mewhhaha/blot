import { createHash } from "node:crypto";

export const compilerStartupChildExecArgv = ["--import", "tsx"] as const;

export function compilerStartupNodeInvocationSha256(
  nodeOptions: string | undefined,
): string {
  let stableNodeOptions: string | null = null;
  if (nodeOptions !== undefined) {
    stableNodeOptions = stableInvocation(nodeOptions);
  }
  return createHash("sha256").update(JSON.stringify({
    execArgv: compilerStartupChildExecArgv.map(stableInvocation),
    nodeOptions: stableNodeOptions,
  })).digest("hex");
}

function stableInvocation(value: string): string {
  return value.replaceAll(process.cwd(), "$repository");
}
