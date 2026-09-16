// Shared worker-job param validators.
///
// Formatting runs compiler-free on the syntax lane while every other service
// method runs against the LanguageService replica, but both sides reject
// malformed formatting params identically: InvalidParams (-32602) with the
// method named. The syntax jobs import this module instead of the service
// executor so the syntax worker stays free of the LanguageService import.

import { ErrorCodes, JsonRpcError } from "../errors.ts";
import { resolveFormattingOptions } from "../../tooling/format/options.ts";

/** Requires params shaped as an object for one method. */
export function paramsObject(
  params: unknown,
  method: string,
): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new JsonRpcError(
      ErrorCodes.InvalidParams,
      `${method} params must be an object`,
    );
  }
  return params as Record<string, unknown>;
}

/** Validates raw formatting options, failing loudly like the service. */
export function requireFormattingOptions(
  params: Record<string, unknown>,
  method: string,
): unknown {
  try {
    return resolveFormattingOptions(params.options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new JsonRpcError(
      ErrorCodes.InvalidParams,
      `${method} options are invalid: ${detail}`,
    );
  }
}
