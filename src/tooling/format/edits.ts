// src/tooling/format/edits.ts
//
// Minimal formatting edits: one linear prefix/suffix replacement.
//
// The formatter validates full output text, but editors apply edits. This
// module derives a single minimal replacement between the captured source
// and the validated output by trimming the common prefix and suffix, then
// trims the boundary to safe UTF-16 and CRLF positions: a boundary never
// splits a surrogate pair or a carriage-return/line-feed pair. Applying the
// edit must reconstruct the validated output exactly; the facade verifies
// that round trip before returning.

import {
  type Position,
  positionAtOffset,
  type Range,
} from "../../text/document.ts";
import { FormatterInvariantError } from "./errors.ts";

export interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}

/**
 * Derives the minimal single edit from source to output. Returns null when
 * the two are identical; callers map that to an empty edit list.
 */
export function deriveEdit(source: string, output: string): TextEdit | null {
  if (source === output) return null;
  let prefix = 0;
  const sharedPrefix = Math.min(source.length, output.length);
  while (prefix < sharedPrefix && source[prefix] === output[prefix]) {
    prefix += 1;
  }
  let sourceEnd = source.length;
  let outputEnd = output.length;
  while (
    sourceEnd > prefix && outputEnd > prefix &&
    source[sourceEnd - 1] === output[outputEnd - 1]
  ) {
    sourceEnd -= 1;
    outputEnd -= 1;
  }
  const safe = safeBoundaries(source, output, prefix, sourceEnd, outputEnd);
  const range: Range = {
    start: positionAtOffset(source, safe.sourceStart),
    end: positionAtOffset(source, safe.sourceEnd),
  };
  return {
    range,
    newText: output.slice(safe.outputStart, safe.outputEnd),
  };
}

/** Applies one derived edit; used to verify the reconstruction round trip. */
export function applyEdit(source: string, edit: TextEdit): string {
  const lineStarts = sourceLineStartsOf(source);
  const start = offsetOf(source, lineStarts, edit.range.start);
  const end = offsetOf(source, lineStarts, edit.range.end);
  return source.slice(0, start) + edit.newText + source.slice(end);
}

/** Verifies that applying the edit reconstructs the output exactly. */
export function assertEditReconstructs(
  source: string,
  output: string,
  edit: TextEdit,
): void {
  const reconstructed = applyEdit(source, edit);
  if (reconstructed !== output) {
    throw new FormatterInvariantError(
      "formatting edit does not reconstruct the validated output",
    );
  }
}

interface SafeBoundaries {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly outputStart: number;
  readonly outputEnd: number;
}

function safeBoundaries(
  source: string,
  output: string,
  prefix: number,
  sourceEnd: number,
  outputEnd: number,
): SafeBoundaries {
  let sourceStart = prefix;
  let outputStart = prefix;
  while (
    sourceStart > 0 &&
    splitsPair(source, sourceStart, output, outputStart, -1)
  ) {
    sourceStart -= 1;
    outputStart -= 1;
  }
  let safeSourceEnd = sourceEnd;
  let safeOutputEnd = outputEnd;
  while (
    safeSourceEnd < source.length &&
    splitsPair(source, safeSourceEnd, output, safeOutputEnd, 1)
  ) {
    safeSourceEnd += 1;
    safeOutputEnd += 1;
  }
  return {
    sourceStart,
    sourceEnd: safeSourceEnd,
    outputStart,
    outputEnd: safeOutputEnd,
  };
}

/**
 * Reports whether a boundary between two offsets splits a surrogate pair
 * or a CRLF pair. Direction -1 inspects the pair ending at the boundary;
 * direction 1 inspects the pair starting at it. Both sides move together
 * because the trimmed regions are equal by construction.
 */
function splitsPair(
  source: string,
  sourceOffset: number,
  output: string,
  outputOffset: number,
  direction: -1 | 1,
): boolean {
  if (direction < 0) {
    return endsWithLead(source, sourceOffset) ||
      endsWithLead(output, outputOffset);
  }
  return startsWithTrail(source, sourceOffset) ||
    startsWithTrail(output, outputOffset);
}

function endsWithLead(text: string, offset: number): boolean {
  if (offset < 1 || offset > text.length) return false;
  const before = text.charCodeAt(offset - 1);
  if (before === 0x0d) {
    if (offset < text.length && text.charCodeAt(offset) === 0x0a) return true;
  }
  if (before >= 0xd800 && before <= 0xdbff) {
    if (offset < text.length) {
      const after = text.charCodeAt(offset);
      if (after >= 0xdc00 && after <= 0xdfff) return true;
    }
  }
  return false;
}

function startsWithTrail(text: string, offset: number): boolean {
  if (offset < 0 || offset >= text.length) return false;
  const at = text.charCodeAt(offset);
  if (at === 0x0a) {
    if (offset > 0 && text.charCodeAt(offset - 1) === 0x0d) return true;
  }
  if (at >= 0xdc00 && at <= 0xdfff) {
    if (offset > 0) {
      const before = text.charCodeAt(offset - 1);
      if (before >= 0xd800 && before <= 0xdbff) return true;
    }
  }
  return false;
}

function sourceLineStartsOf(source: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function offsetOf(
  source: string,
  lineStarts: readonly number[],
  position: Position,
): number {
  const line = Math.max(0, Math.min(position.line, lineStarts.length - 1));
  const lineStart = lineStarts[line];
  if (lineStart === undefined) {
    throw new FormatterInvariantError("edit line has no start offset");
  }
  let lineEnd = source.indexOf("\n", lineStart);
  if (lineEnd < 0) lineEnd = source.length;
  return Math.min(lineStart + Math.max(0, position.character), lineEnd);
}
