// src/tooling/format/doc.ts
//
// Document algebra and bounded renderer for the Blot printer.
//
// The algebra is the standard Wadler/Lindig set: text, concatenation,
// group, indent, softline, hardline, ifBreak, plus a trailing-comment
// mechanism (lineSuffix) and an absolute-indent hardline (hardlineTo) used
// only for preservation: lines the pipeline keeps from the source carry
// their original indentation instead of a recomputed level.
//
// The renderer is iterative (explicit stack, no recursion), precomputes
// each subtree flat width exactly once into a cache, and enforces
// deterministic node, depth, and byte budgets. It never flattens a subtree
// twice and never scans per-line regions: output is emitted in one pass.

import {
  FormatInputTooDeepError,
  FormatInputTooLargeError,
  FormatterInvariantError,
} from "./errors.ts";

export type Doc =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "concat"; readonly parts: readonly Doc[] }
  | { readonly kind: "group"; readonly body: Doc }
  | { readonly kind: "indent"; readonly body: Doc }
  | { readonly kind: "softline" }
  | { readonly kind: "hardline" }
  | { readonly kind: "hardlineTo"; readonly width: number }
  | { readonly kind: "lateHardline"; readonly resolve: () => number }
  | { readonly kind: "ifBreak"; readonly broken: Doc; readonly flat: Doc }
  | { readonly kind: "lineSuffix"; readonly body: Doc };

export function text(value: string): Doc {
  return { kind: "text", text: value };
}

export function concat(parts: readonly Doc[]): Doc {
  return { kind: "concat", parts };
}

export function group(body: Doc): Doc {
  return { kind: "group", body };
}

export function indent(body: Doc): Doc {
  return { kind: "indent", body };
}

export function softline(): Doc {
  return { kind: "softline" };
}

export function hardline(): Doc {
  return { kind: "hardline" };
}

/**
 * A hard break carrying an absolute indentation width. Only the
 * preservation path uses this: kept source lines render at their original
 * width even when the relative indent stack disagrees.
 */
export function hardlineTo(width: number): Doc {
  return { kind: "hardlineTo", width };
}

/**
 * A hard break whose width resolves after the document is built. The
 * printer emits these while depths are still settling (width-driven
 * group breaks shift subtrees bottom-up after descendant gaps exist)
 * and resolves every one before rendering; an unresolved node reaching
 * the renderer is a pipeline invariant failure.
 */
export function lateHardline(resolve: () => number): Doc {
  return { kind: "lateHardline", resolve };
}

export function ifBreak(broken: Doc, flat: Doc): Doc {
  return { kind: "ifBreak", broken, flat };
}

/** Trailing content (an end-of-line comment) flushed before the next break. */
export function lineSuffix(body: Doc): Doc {
  return { kind: "lineSuffix", body };
}

export interface RenderLimits {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxBytes: number;
}

export interface RenderOptions {
  readonly width: number;
  readonly limits: RenderLimits;
  /**
   * Nodes whose starting line and column are recorded. The pipeline marks
   * lambda boundaries to evaluate the poison-discard trigger on the
   * rendered layout.
   */
  readonly mark?: ReadonlySet<Doc>;
}

export interface MarkedPosition {
  readonly line: number;
  readonly column: number;
}

export interface RenderRecord {
  /** Per-group broken choice, keyed by group node identity. */
  readonly groupsBroken: ReadonlyMap<Doc, boolean>;
  /** Starting positions of marked nodes. */
  readonly marks: ReadonlyMap<Doc, MarkedPosition>;
  /** Ending column of every emitted line, including the last. */
  readonly lineEnds: readonly number[];
  /** Cached flat width per node, for trigger evaluation. */
  readonly flatWidths: ReadonlyMap<Doc, number>;
}

const INFINITY = Number.POSITIVE_INFINITY;

/**
 * Renders a document at the given width with its record. Flat widths are
 * cached per node so no subtree is measured twice; the main loop is
 * iterative. The printer always needs the record (group choices, trigger
 * evaluation), so there is no record-less entry point.
 */
export function renderWithRecord(
  doc: Doc,
  options: RenderOptions,
): { readonly text: string; readonly record: RenderRecord } {
  const flatWidths = flatWidthCache(doc, options.limits);
  const chunks: string[] = [];
  let bytes = 0;
  let visited = 0;
  const groupsBroken = new Map<Doc, boolean>();
  const marks = new Map<Doc, MarkedPosition>();
  const lineEnds: number[] = [];
  let pendingIndent: number | null = 0;
  let pendingSuffix = "";
  let column = 0;
  let line = 0;

  interface Frame {
    readonly node: Doc;
    readonly flat: boolean;
    readonly indent: number;
    readonly depth: number;
  }
  const stack: Frame[] = [{ node: doc, flat: false, indent: 0, depth: 0 }];

  const pushText = (value: string): void => {
    if (pendingSuffix !== "") {
      appendChunk(pendingSuffix);
      pendingSuffix = "";
    }
    if (pendingIndent !== null) {
      appendChunk(" ".repeat(pendingIndent));
      pendingIndent = null;
    }
    appendChunk(value);
  };

  function appendChunk(value: string): void {
    chunks.push(value);
    bytes += value.length;
    if (bytes > options.limits.maxBytes) {
      throw new FormatInputTooLargeError(
        `formatted output exceeds ${options.limits.maxBytes} bytes`,
      );
    }
    const lastBreak = value.lastIndexOf("\n");
    if (lastBreak < 0) {
      column += value.length;
    } else {
      column = value.length - lastBreak - 1;
    }
  }

  const pushBreak = (width: number): void => {
    if (pendingSuffix !== "") {
      if (pendingIndent !== null) {
        appendChunk(" ".repeat(pendingIndent));
        pendingIndent = null;
      }
      appendChunk(pendingSuffix);
      pendingSuffix = "";
    }
    lineEnds.push(column);
    appendChunk("\n");
    line += 1;
    pendingIndent = width;
  };

  const marked = options.mark;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    visited += 1;
    if (visited > options.limits.maxNodes) {
      throw new FormatInputTooLargeError(
        `formatted document exceeds ${options.limits.maxNodes} nodes`,
      );
    }
    const node = frame.node;
    if (marked !== undefined && marked.has(node) && !marks.has(node)) {
      let startColumn = column + pendingSuffix.length;
      if (pendingIndent !== null) startColumn += pendingIndent;
      marks.set(node, { line, column: startColumn });
    }
    if (node.kind === "text") {
      pushText(node.text);
      continue;
    }
    if (node.kind === "concat") {
      for (let index = node.parts.length - 1; index >= 0; index -= 1) {
        const part = node.parts[index];
        if (part === undefined) continue;
        stack.push({
          node: part,
          flat: frame.flat,
          indent: frame.indent,
          depth: frame.depth,
        });
      }
      continue;
    }
    if (node.kind === "group") {
      if (frame.flat) {
        stack.push({
          node: node.body,
          flat: true,
          indent: frame.indent,
          depth: frame.depth,
        });
        continue;
      }
      const width = flatWidths.get(node);
      let startColumn = column;
      if (pendingIndent !== null) startColumn += pendingIndent;
      const fits = width !== undefined &&
        width <= options.width - startColumn;
      groupsBroken.set(node, !fits);
      stack.push({
        node: node.body,
        flat: fits,
        indent: frame.indent,
        depth: frame.depth,
      });
      continue;
    }
    if (node.kind === "indent") {
      const depth = frame.depth + 1;
      if (depth > options.limits.maxDepth) {
        throw new FormatInputTooDeepError(
          `formatted document exceeds depth ${options.limits.maxDepth}`,
        );
      }
      stack.push({
        node: node.body,
        flat: frame.flat,
        indent: frame.indent + 1,
        depth,
      });
      continue;
    }
    if (node.kind === "softline") {
      if (frame.flat) {
        pushText(" ");
      } else {
        pushBreak(frame.indent * 2);
      }
      continue;
    }
    if (node.kind === "hardline") {
      pushBreak(frame.indent * 2);
      continue;
    }
    if (node.kind === "hardlineTo") {
      pushBreak(node.width);
      continue;
    }
    if (node.kind === "lateHardline") {
      throw new FormatterInvariantError(
        "formatted document kept an unresolved indent",
      );
    }
    if (node.kind === "ifBreak") {
      let branch = node.broken;
      if (frame.flat) branch = node.flat;
      stack.push({
        node: branch,
        flat: frame.flat,
        indent: frame.indent,
        depth: frame.depth,
      });
      continue;
    }
    if (node.kind === "lineSuffix") {
      pendingSuffix += renderFlat(node.body, options.limits);
      continue;
    }
  }
  if (pendingSuffix !== "") {
    if (pendingIndent !== null) {
      appendChunk(" ".repeat(pendingIndent));
      pendingIndent = null;
    }
    appendChunk(pendingSuffix);
  }
  lineEnds.push(column);
  return {
    text: chunks.join(""),
    record: { groupsBroken, marks, lineEnds, flatWidths },
  };
}

/**
 * Measures every subtree flat width once, bottom-up over an explicit
 * stack. A flat width is the single-line length, or infinity when the
 * subtree must break (hard break, preserved break, or multiline text).
 */
function flatWidthCache(doc: Doc, limits: RenderLimits): Map<Doc, number> {
  const widths = new Map<Doc, number>();
  const stack: Array<{ readonly node: Doc; readonly expanded: boolean }> = [
    { node: doc, expanded: false },
  ];
  let visited = 0;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    visited += 1;
    if (visited > limits.maxNodes) {
      throw new FormatInputTooLargeError(
        `formatted document exceeds ${limits.maxNodes} nodes`,
      );
    }
    const node = frame.node;
    if (widths.has(node)) continue;
    if (!frame.expanded) {
      stack.push({ node, expanded: true });
      pushChildren(node, stack);
      continue;
    }
    widths.set(node, combineWidth(node, widths));
  }
  return widths;
}

function pushChildren(
  node: Doc,
  stack: Array<{ readonly node: Doc; readonly expanded: boolean }>,
): void {
  if (node.kind === "concat") {
    for (const part of node.parts) stack.push({ node: part, expanded: false });
  } else if (node.kind === "group" || node.kind === "indent") {
    stack.push({ node: node.body, expanded: false });
  } else if (node.kind === "ifBreak") {
    stack.push({ node: node.flat, expanded: false });
    stack.push({ node: node.broken, expanded: false });
  } else if (node.kind === "lineSuffix") {
    stack.push({ node: node.body, expanded: false });
  }
}

function combineWidth(node: Doc, widths: Map<Doc, number>): number {
  if (node.kind === "text") {
    if (node.text.includes("\n")) return INFINITY;
    return node.text.length;
  }
  if (node.kind === "concat") {
    let total = 0;
    for (const part of node.parts) {
      const width = widths.get(part);
      if (width === undefined || width >= INFINITY) return INFINITY;
      total += width;
      if (total >= INFINITY) return INFINITY;
    }
    return total;
  }
  if (node.kind === "group" || node.kind === "indent") {
    return cachedWidth(widths, node.body);
  }
  if (node.kind === "softline") return 1;
  if (node.kind === "lateHardline") {
    throw new FormatterInvariantError(
      "formatted document kept an unresolved indent",
    );
  }
  if (node.kind === "hardline" || node.kind === "hardlineTo") return INFINITY;
  if (node.kind === "ifBreak") return cachedWidth(widths, node.flat);
  return cachedWidth(widths, node.body);
}

function cachedWidth(widths: Map<Doc, number>, node: Doc): number {
  const width = widths.get(node);
  if (width === undefined) return INFINITY;
  return width;
}

/** Renders suffix content flat; suffixes never contain breaks. */
function renderFlat(body: Doc, limits: RenderLimits): string {
  const chunks: string[] = [];
  const stack: Doc[] = [body];
  let visited = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    visited += 1;
    if (visited > limits.maxNodes) {
      throw new FormatInputTooLargeError(
        `formatted suffix exceeds ${limits.maxNodes} nodes`,
      );
    }
    if (node.kind === "text") {
      chunks.push(node.text);
    } else if (node.kind === "concat") {
      for (let index = node.parts.length - 1; index >= 0; index -= 1) {
        const part = node.parts[index];
        if (part !== undefined) stack.push(part);
      }
    } else if (node.kind === "group" || node.kind === "indent") {
      stack.push(node.body);
    } else if (node.kind === "softline") {
      chunks.push(" ");
    } else if (node.kind === "ifBreak") {
      stack.push(node.flat);
    } else if (node.kind === "lineSuffix") {
      stack.push(node.body);
    } else {
      throw new FormatInputTooLargeError(
        "trailing comment content must not break",
      );
    }
  }
  return chunks.join("");
}
