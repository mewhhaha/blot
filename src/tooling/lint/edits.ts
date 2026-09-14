import type { LintEdit, LintFix } from "./types.ts";

export function orderedLintEdits(
  edits: readonly LintEdit[],
): readonly LintEdit[] {
  if (edits.length === 0) throw new Error("A lint fix must contain an edit");
  const ordered = edits.toSorted((left, right) =>
    left.span.start - right.span.start || left.span.end - right.span.end
  );
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    if (current.span.start < 0 || current.span.end < current.span.start) {
      throw new Error("A lint edit has an invalid source span");
    }
    const previous = ordered[index - 1];
    if (previous !== undefined && lintEditsOverlap(previous, current)) {
      throw new Error("A lint fix contains overlapping edits");
    }
  }
  return ordered;
}

export function lintEditsOverlap(left: LintEdit, right: LintEdit): boolean {
  return left.span.start <= right.span.end &&
    right.span.start <= left.span.end &&
    (left.span.start === right.span.start ||
      (left.span.start < right.span.end && right.span.start < left.span.end));
}

export function applyLintFix(source: string, fix: LintFix): string {
  const edits = orderedLintEdits(fix.edits);
  let result = source;
  for (const edit of edits.toReversed()) {
    if (edit.span.end > source.length) {
      throw new Error("A lint edit extends beyond its source revision");
    }
    result = result.slice(0, edit.span.start) + edit.replacement +
      result.slice(edit.span.end);
  }
  return result;
}
