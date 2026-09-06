import type { CompilerExplanation } from "../compiler.ts";

export interface ExplainLocation {
  readonly line: number;
  readonly column: number;
}

export type ExplainInvocation =
  | {
    readonly ok: true;
    readonly path: string;
    readonly location: ExplainLocation;
    readonly json: boolean;
  }
  | { readonly ok: false; readonly message: string };

const usage = "usage: blot explain [--json] <file.blot> <line>:<column>";

export function parseExplainArguments(
  arguments_: readonly string[],
): ExplainInvocation {
  const values = [...arguments_];
  let json = false;
  if (values[0] === "--json") {
    json = true;
    values.shift();
  }
  if (values.length !== 2 || values[0].startsWith("--")) {
    return { ok: false, message: usage };
  }
  const match = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(values[1]);
  if (match === null) return { ok: false, message: usage };
  const line = Number(match[1]);
  const column = Number(match[2]);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)) {
    return { ok: false, message: usage };
  }
  return { ok: true, path: values[0], location: { line, column }, json };
}

/** One-based lines and UTF-16 columns, matching the editor and locate(). */
export function sourceOffset(
  source: string,
  location: ExplainLocation,
): number {
  if (
    !Number.isSafeInteger(location.line) || location.line < 1 ||
    !Number.isSafeInteger(location.column) || location.column < 1
  ) {
    throw new RangeError("line and column must be positive safe integers");
  }
  let start = 0;
  for (let line = 1; line < location.line; line += 1) {
    const newline = source.indexOf("\n", start);
    if (newline === -1) {
      throw new RangeError(`source has no line ${location.line}`);
    }
    start = newline + 1;
  }
  let end = source.indexOf("\n", start);
  if (end === -1) end = source.length;
  if (end > start && source[end - 1] === "\r") end -= 1;
  const offset = start + location.column - 1;
  if (offset > end) {
    throw new RangeError(
      `line ${location.line} has no column ${location.column}`,
    );
  }
  return offset;
}

export function renderExplanation(
  path: string,
  location: ExplainLocation,
  explanation: CompilerExplanation | null,
): string {
  const position = `${path}:${location.line}:${location.column}`;
  if (explanation === null) {
    return `${position}: no compiler explanation is recorded at this position`;
  }
  let heading = `${position}: ${explanation.kind}: ${explanation.summary}`;
  // A target preflight describes the module, not a fabricated source span.
  if (explanation.kind === "target") {
    heading = `${path}: module target: ${explanation.summary}`;
  }
  return [heading, ...explanation.reasons.map((reason) => `  ${reason}`)].join(
    "\n",
  );
}
