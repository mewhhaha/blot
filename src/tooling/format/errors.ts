// src/tooling/format/errors.ts
//
// Typed failures for the formatting pipeline. The pipeline distinguishes
// three outcomes: formatted text, source diagnostics (invalid input formats
// to no edits), and typed failures below. Cancellation, over-limit input,
// and invariant breaks are never silent empty results.

/** The printer produced text whose representation differs from the input. */
export class FormatterInvariantError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FormatterInvariantError";
  }
}

/** Input exceeds a deterministic byte or node bound. */
export class FormatInputTooLargeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FormatInputTooLargeError";
  }
}

/** Input nesting exceeds the deterministic depth bound. */
export class FormatInputTooDeepError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FormatInputTooDeepError";
  }
}

/** Formatting was cancelled through an abort signal. */
export class FormatCancelledError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FormatCancelledError";
  }
}
