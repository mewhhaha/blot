export type BuildMode = "direct" | "service";
export type BuildTarget = "gpufuck" | "gpupaper";

export interface BuildArguments {
  readonly mode: BuildMode;
  readonly target: BuildTarget;
  readonly paths: readonly string[];
  readonly serviceUrl: string | undefined;
}

export function parseBuildArguments(
  arguments_: readonly string[],
): BuildArguments {
  let mode: BuildMode = "direct";
  let target: BuildTarget = "gpupaper";
  let serviceUrl: string | undefined;
  const paths: string[] = [];
  for (const argument of arguments_) {
    if (argument === "--mode=direct") {
      mode = "direct";
      continue;
    }
    if (argument === "--mode=service") {
      mode = "service";
      continue;
    }
    if (argument === "--target=gpufuck") {
      target = "gpufuck";
      continue;
    }
    if (argument === "--target=gpupaper") {
      target = "gpupaper";
      continue;
    }
    if (argument.startsWith("--service-url=")) {
      serviceUrl = argument.slice("--service-url=".length);
      if (serviceUrl.length === 0) {
        throw new Error("--service-url requires an HTTP URL");
      }
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`unknown build option ${JSON.stringify(argument)}`);
    }
    paths.push(argument);
  }
  if (serviceUrl !== undefined && mode !== "service") {
    throw new Error("--service-url requires --mode=service");
  }
  if (target === "gpupaper" && mode === "service") {
    throw new Error("--target=gpupaper does not support --mode=service");
  }
  return { mode, target, paths, serviceUrl };
}
