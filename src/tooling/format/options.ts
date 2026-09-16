// src/tooling/format/options.ts
//
// Single home for formatter option resolution, shared by the CLI and the
// language server so both produce identical behavior.
//
// House style is fixed: 80 columns, two-space indentation, LF line endings,
// one final newline. Client indent and end-of-line preferences are parsed
// and validated so misconfigured clients fail loudly, but they never
// override the house style. Internal resource bounds are separate from
// style: callers pass PrintLimits to refuse oversized or overly deep input
// deterministically.
//
// Two option shapes are accepted. The language server speaks LSP
// FormattingOptions (tabSize, insertSpaces, trim/insert-newline flags, plus
// client custom keys carrying a boolean, integer, or string, per LSP 3.17).
// Direct callers may use the internal shape (indentWidth, useTabs,
// endOfLine). Both validate strictly and resolve to the same fixed style.

export interface FormattingOptions {
  readonly indentWidth?: number;
  readonly useTabs?: boolean;
  readonly endOfLine?: string;
  readonly tabSize?: number;
  readonly insertSpaces?: boolean;
  readonly trimTrailingWhitespace?: boolean;
  readonly insertFinalNewline?: boolean;
  readonly trimFinalNewlines?: boolean;
  readonly [custom: string]: unknown;
}

export interface ResolvedStyle {
  /** Always 80: the documented house width. */
  readonly width: number;
  /** Always two spaces: the documented house indent. */
  readonly indentWidth: number;
}

export interface PrintLimits {
  readonly maxInputBytes: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxBytes: number;
}

export const HOUSE_WIDTH = 80;
export const HOUSE_INDENT_WIDTH = 2;

export const DEFAULT_PRINT_LIMITS: PrintLimits = {
  maxInputBytes: 1 << 20,
  maxNodes: 1 << 20,
  maxDepth: 256,
  maxBytes: 1 << 22,
};

const KNOWN_OPTIONS = new Set([
  "indentWidth",
  "useTabs",
  "endOfLine",
  "tabSize",
  "insertSpaces",
  "trimTrailingWhitespace",
  "insertFinalNewline",
  "trimFinalNewlines",
]);

/**
 * Validates raw client options. Mistyped values throw a TypeError;
 * accepted preferences are recorded but never change the fixed house
 * style. Beyond the known keys, LSP custom keys are allowed when they
 * carry a boolean, integer, or string value.
 */
export function resolveFormattingOptions(
  raw: unknown,
): FormattingOptions {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("formatting options must be an object");
  }
  const record = raw as Record<string, unknown>;
  const options: { [key: string]: unknown } = {};
  if (record.indentWidth !== undefined) {
    options.indentWidth = checkWidth(record.indentWidth, "indentWidth");
  }
  if (record.tabSize !== undefined) {
    options.tabSize = checkWidth(record.tabSize, "tabSize");
  }
  if (record.useTabs !== undefined) {
    options.useTabs = checkFlag(record.useTabs, "useTabs");
  }
  if (record.insertSpaces !== undefined) {
    options.insertSpaces = checkFlag(record.insertSpaces, "insertSpaces");
  }
  if (record.trimTrailingWhitespace !== undefined) {
    options.trimTrailingWhitespace = checkFlag(
      record.trimTrailingWhitespace,
      "trimTrailingWhitespace",
    );
  }
  if (record.insertFinalNewline !== undefined) {
    options.insertFinalNewline = checkFlag(
      record.insertFinalNewline,
      "insertFinalNewline",
    );
  }
  if (record.trimFinalNewlines !== undefined) {
    options.trimFinalNewlines = checkFlag(
      record.trimFinalNewlines,
      "trimFinalNewlines",
    );
  }
  if (record.endOfLine !== undefined) {
    if (
      record.endOfLine !== "\n" && record.endOfLine !== "\r\n" &&
      record.endOfLine !== "lf" && record.endOfLine !== "crlf"
    ) {
      throw new TypeError("formatting endOfLine must name LF or CRLF");
    }
    options.endOfLine = record.endOfLine;
  }
  for (const key of Object.keys(record)) {
    if (KNOWN_OPTIONS.has(key)) continue;
    options[key] = checkCustomKey(key, record[key]);
  }
  return options;
}

function checkWidth(value: unknown, name: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
  ) {
    throw new TypeError(`formatting ${name} must be a safe integer`);
  }
  return value;
}

function checkFlag(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`formatting ${name} must be a boolean`);
  }
  return value;
}

function checkCustomKey(
  key: string,
  value: unknown,
): boolean | number | string {
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new TypeError(
    `formatting option ${
      JSON.stringify(key)
    } must be a boolean, integer, or string`,
  );
}

/** Resolves the effective style: always the fixed house style. */
export function resolveStyle(_options: FormattingOptions): ResolvedStyle {
  return { width: HOUSE_WIDTH, indentWidth: HOUSE_INDENT_WIDTH };
}

/** Merges caller bounds over the defaults, validating ranges. */
export function resolveLimits(
  raw: Partial<PrintLimits> | undefined,
): PrintLimits {
  if (raw === undefined) return DEFAULT_PRINT_LIMITS;
  const merged: PrintLimits = {
    maxInputBytes: withDefault(
      checkBound(raw.maxInputBytes, "maxInputBytes"),
      DEFAULT_PRINT_LIMITS.maxInputBytes,
    ),
    maxNodes: withDefault(
      checkBound(raw.maxNodes, "maxNodes"),
      DEFAULT_PRINT_LIMITS.maxNodes,
    ),
    maxDepth: withDefault(
      checkBound(raw.maxDepth, "maxDepth"),
      DEFAULT_PRINT_LIMITS.maxDepth,
    ),
    maxBytes: withDefault(
      checkBound(raw.maxBytes, "maxBytes"),
      DEFAULT_PRINT_LIMITS.maxBytes,
    ),
  };
  return merged;
}

function withDefault(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return value;
}

function checkBound(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 1
  ) {
    throw new TypeError(`print limit ${name} must be a positive integer`);
  }
  return value;
}
