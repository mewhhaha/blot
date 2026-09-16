// src/text/document.ts
//
// Immutable source text plus the single home for UTF-16 position helpers.
//
// P1 moves the line helpers here (they used to live in the formatter and were
// imported by the language service) so editor text handling never depends on
// formatter behavior. This module imports nothing: it is the foundation that
// formatter, language service, and benchmarks all build on.
//
// Position contract (preserved verbatim from the pre-P1 implementation; P1
// changes no user-visible behavior):
// - Offsets and character columns are UTF-16 code units, matching LSP and
//   JavaScript string indexing. An astral character (for example U+1F600)
//   occupies two columns, not one.
// - Lines split on "\n" only. A carriage return is ordinary line content, so
//   in CRLF text the "\r" counts as one character and clamping a column to a
//   CRLF line end yields the offset of the "\n".
// - Conversions clamp out-of-range inputs instead of throwing: offsets clamp
//   to [0, source.length], lines clamp to the last line, and columns clamp to
//   the line end (the offset of the next "\n", or the end of the source).
// - Conversions never snap to surrogate-pair boundaries. A column that lands
//   between a lead and trail surrogate yields the raw offset between them;
//   callers must not send mid-pair positions.

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

export interface ContentChange {
  readonly range?: Range;
  readonly rangeLength?: number;
  readonly text: string;
}

// Immutable source plus its precomputed line index. Instances are frozen;
// applyChanges returns a new document and never mutates the receiver.
export class TextDocument {
  readonly source: string;
  readonly lineStarts: readonly number[];

  constructor(source: string) {
    this.source = source;
    this.lineStarts = Object.freeze(sourceLineStarts(source));
    Object.freeze(this);
  }

  offsetAt(position: Position): number {
    return offsetAtPositionWithStarts(
      this.source,
      this.lineStarts,
      position,
    );
  }

  positionAt(offset: number): Position {
    return positionAtOffsetWithStarts(
      this.source,
      this.lineStarts,
      offset,
    );
  }

  rangeOf(span: TextSpan): Range {
    return {
      start: this.positionAt(span.start),
      end: this.positionAt(span.end),
    };
  }

  applyChanges(
    changes: readonly ContentChange[],
    documentUri: string,
  ): TextDocument {
    return new TextDocument(
      applyContentChanges(this.source, changes, documentUri),
    );
  }
}

export function sourceLineStarts(source: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

export function lineAtOffset(
  lineStarts: readonly number[],
  offset: number,
): number {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low;
}

export function positionAtOffset(source: string, offset: number): Position {
  return positionAtOffsetWithStarts(
    source,
    sourceLineStarts(source),
    offset,
  );
}

export function offsetAtPosition(source: string, position: Position): number {
  return offsetAtPositionWithStarts(
    source,
    sourceLineStarts(source),
    position,
  );
}

export function rangeOf(source: string, span: TextSpan): Range {
  return {
    start: positionAtOffset(source, span.start),
    end: positionAtOffset(source, span.end),
  };
}

function positionAtOffsetWithStarts(
  source: string,
  lineStarts: readonly number[],
  offset: number,
): Position {
  const boundedOffset = Math.max(0, Math.min(offset, source.length));
  const line = lineAtOffset(lineStarts, boundedOffset);
  const lineStart = lineStarts[line];
  if (lineStart === undefined) {
    throw new Error(`line ${line} has no start offset`);
  }
  return { line, character: boundedOffset - lineStart };
}

function offsetAtPositionWithStarts(
  source: string,
  lineStarts: readonly number[],
  position: Position,
): number {
  const line = Math.max(0, Math.min(position.line, lineStarts.length - 1));
  const lineStart = lineStarts[line];
  if (lineStart === undefined) {
    throw new Error(`line ${line} has no start offset`);
  }
  let lineEnd = source.indexOf("\n", lineStart);
  if (lineEnd < 0) lineEnd = source.length;
  return Math.min(lineStart + Math.max(0, position.character), lineEnd);
}

// Applies LSP content changes to a source string. Ordered incremental ranges
// apply to the progressively updated source: each range is interpreted after
// all earlier changes in the array have been applied. A change without a
// range replaces the full content. rangeLength, when present, must equal the
// replaced span length in UTF-16 code units.
export function applyContentChanges(
  source: string,
  changes: readonly ContentChange[],
  documentUri: string,
): string {
  let updated = source;
  for (const change of changes) {
    if (change.range === undefined) {
      updated = change.text;
      continue;
    }
    const start = offsetAtPosition(updated, change.range.start);
    const end = offsetAtPosition(updated, change.range.end);
    if (end < start) {
      throw new Error(
        `document ${documentUri} change range ends before it starts`,
      );
    }
    if (
      change.rangeLength !== undefined &&
      change.rangeLength !== end - start
    ) {
      throw new Error(
        `document ${documentUri} change range length ${change.rangeLength} does not match ${
          end - start
        }`,
      );
    }
    updated = updated.slice(0, start) + change.text + updated.slice(end);
  }
  return updated;
}

// Non-cryptographic content identity for cache keys: the UTF-16 length plus
// the FNV-1a hash of the UTF-16 code units. Cache lookups must still verify
// full source equality (see src/text/cache.ts); the hash only shortens keys.
export function contentId(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${source.length}:${hash.toString(16)}`;
}
