// src/tooling/format/print.ts
//
// Lossless CST-to-document printer.
//
// Print builds one document from the IR and renders it in at most two
// fixed phases: a measuring render records lambda and case-arm positions,
// then the pipeline either reuses it, rebuilds once with outcome-based
// case separation, or rebuilds once in poison-discard fallback. No phase
// parses; group-fit columns are the only feedback, and blank insertion
// provably preserves them, so two renders always suffice.
//
// Emission walks rules bottom-up over an explicit stack. Tokens print
// verbatim (literals byte-identical, comments repositioned but never
// rescanned), gaps follow the ported horizontal rules, and line indents
// are relative levels except for preserved source lines, which carry
// absolute widths. Anchors under preserved lines shift relatively.

import type { Cursor, Rule, TokenCursor } from "../../syntax/cursor.ts";
import { lineAtOffset } from "../../text/document.ts";
import { FormatterInvariantError } from "./errors.ts";
import {
  concat,
  type Doc,
  group,
  hardline,
  hardlineTo,
  ifBreak,
  indent,
  lateHardline,
  lineSuffix,
  type RenderRecord,
  renderWithRecord,
  text,
} from "./doc.ts";
import {
  childRules,
  DELIMITED_RULES,
  directRule,
  directRules,
  directToken,
  type FormatIr,
  type IrNode,
  type IrToken,
  LAYOUT_SENSITIVE_RULES,
  SUITE_STATEMENT_RULES,
} from "./ir.ts";
import type { PrintLimits } from "./options.ts";
import type { TapeComment } from "./trivia.ts";

export interface PrintInput {
  readonly ir: FormatIr;
  readonly width: number;
  readonly limits: PrintLimits;
}

const KEYWORDS = new Set([
  "fn",
  "return",
  "case",
  "of",
  "if",
  "else",
  "for",
  "in",
  "open",
  "import",
  "use",
  "module",
  "with",
  "let",
  "const",
  "rec",
]);

const OPERATORS = new Set(["=", ":=", "::", "<-", "=>"]);
const TIGHT_RIGHT = new Set([")", "]", ",", ";", ":"]);
const TIGHT_LEFT = new Set(["(", "[", ".", "#"]);

interface TokenTriviaOwned {
  readonly leading: readonly TapeComment[];
  readonly trailing: readonly TapeComment[];
}

/** Observation-only statistics for the facade metrics hooks. */
export interface PrintStats {
  readonly spacingChanged: boolean;
  readonly groupingDrops: number;
  readonly dropsApplied: boolean;
  readonly usedFallback: boolean;
}

/**
 * Prints the IR to validated-ready text (exactly one trailing newline).
 * At most two measuring renders run: the pipeline either reuses the first,
 * rebuilds once with outcome-based case separation, or rebuilds once in
 * poison-discard fallback. No phase parses.
 */
export function printIr(
  input: PrintInput,
): { readonly text: string; readonly stats: PrintStats } {
  const builder = new Printer(input.ir, input.width, input.limits, false);
  if (input.ir.plan.fallback) {
    return { text: builder.renderFallback(), stats: builder.stats() };
  }
  const first = builder.renderNormal();
  const trigger = builder.findLambdaTrigger(first.record);
  if (trigger !== null) {
    const fallback = new Printer(input.ir, input.width, input.limits, true);
    return { text: fallback.renderFallback(), stats: fallback.stats() };
  }
  if (builder.needsOutcomeSeparation(first.record)) {
    builder.enableOutcomeSeparation(first.record);
    const second = builder.renderNormal();
    return { text: second.text, stats: builder.stats() };
  }
  return { text: first.text, stats: builder.stats() };
}

/**
 * Closing-delimiter normalization for the fallback path, ported from the
 * retired line pass: a line holding only a closing delimiter (plus an
 * optional comma or semicolon) dedents to at most the previous line's
 * indent minus one level. Indentation counts spaces only.
 */
function applyClosingNorm(rendered: string): string {
  const lines = rendered.split("\n");
  let previousIndent: number | null = null;
  const normalized: string[] = [];
  for (const line of lines) {
    const content = line.trim();
    if (content === "") {
      normalized.push("");
      continue;
    }
    const match = line.match(/^[ ]*/);
    if (match === null) {
      throw new FormatterInvariantError("preserved line has no indentation");
    }
    const currentIndent = match[0].length;
    let indent = currentIndent;
    if (/^[)\]}][,;]?$/.test(content) && previousIndent !== null) {
      indent = Math.min(currentIndent, Math.max(0, previousIndent - 2));
    }
    previousIndent = indent;
    normalized.push(`${" ".repeat(indent)}${content}`);
  }
  return normalized.join("\n");
}

class Printer {
  private readonly ir: FormatIr;
  private readonly width: number;
  private readonly limits: PrintLimits;
  private readonly fallback: boolean;
  private readonly droppedTokens = new Set<number>();
  private readonly ownedTrivia = new Map<number, TokenTriviaOwned>();
  private readonly spacedOperators = new Set<number>();
  private readonly tightPrefixes = new Set<number>();
  private readonly tightDots = new Set<number>();
  private readonly firstLeaf = new Map<Rule, number>();
  private readonly touched = new Set<Rule>();
  private readonly depths = new Map<Rule, number>();
  private readonly preservedBase = new Map<Rule, PreservedBase>();
  private readonly lambdaMarks = new Map<
    Rule,
    { readonly start: Doc; readonly end: Doc; readonly flat: Doc }
  >();
  private readonly armMarks = new Map<
    Rule,
    { readonly start: Doc; readonly end: Doc }
  >();
  private readonly armBodies = new Map<Rule, Rule>();
  private readonly outcomeMultiline = new Map<Rule, boolean>();
  private readonly marked: Set<Doc> = new Set();
  private outcomeSeparation: RenderRecord | null = null;
  private readonly firstMemo = new Map<Cursor, number | null>();
  private readonly lastMemo = new Map<Cursor, number | null>();
  private readonly contentEnds = new Map<Cursor, number>();
  private readonly unjoinableMemo = new Map<Rule, boolean>();
  private readonly arrayModes = new Map<Rule, "group" | "keep" | "rebreak">();
  private readonly tupleModes = new Map<Rule, "group" | "keep" | "rebreak">();
  private readonly shiftedDelimiters = new Set<Rule>();
  private readonly lambdaGrouped = new Set<Rule>();
  private readonly tokenDocs = new Map<number, Doc>();
  private readonly leafIndexByCursor = new Map<TokenCursor, number>();
  private readonly commentInsideMemo = new Map<Rule, boolean>();
  private spacingChanged = false;
  private groupingDrops = 0;

  constructor(
    ir: FormatIr,
    width: number,
    limits: PrintLimits,
    fallback: boolean,
  ) {
    this.ir = ir;
    this.width = width;
    this.limits = limits;
    this.fallback = fallback;
    for (let index = 0; index < ir.leaves.length; index += 1) {
      const leaf = ir.leaves[index];
      if (leaf !== undefined) this.leafIndexByCursor.set(leaf.token, index);
    }
    this.indexLeaves();
    this.collectDroppedTokens();
    this.collectSpacingFlags();
    this.markTouched();
    this.assignDepths();
    this.assignPreservedBases();
  }

  stats(): PrintStats {
    return {
      spacingChanged: this.spacingChanged,
      groupingDrops: this.groupingDrops,
      dropsApplied: this.droppedTokens.size > 0,
      usedFallback: this.fallback,
    };
  }

  renderNormal(): { readonly text: string; readonly record: RenderRecord } {
    const doc = this.buildDocument();
    const rendered = renderWithRecord(doc, {
      width: this.width,
      limits: {
        maxNodes: this.limits.maxNodes,
        maxDepth: this.limits.maxDepth,
        maxBytes: this.limits.maxBytes,
      },
      mark: this.marked,
    });
    return { text: this.finishText(rendered.text), record: rendered.record };
  }

  renderFallback(): string {
    const doc = this.buildDocument();
    const rendered = renderWithRecord(doc, {
      width: this.width,
      limits: {
        maxNodes: this.limits.maxNodes,
        maxDepth: this.limits.maxDepth,
        maxBytes: this.limits.maxBytes,
      },
    });
    const closed = applyClosingNorm(rendered.text);
    return this.finishText(closed);
  }

  needsOutcomeSeparation(record: RenderRecord): boolean {
    for (const [rule, marks] of this.armMarks) {
      const body = this.armBodies.get(rule);
      if (body === undefined) {
        throw new FormatterInvariantError("case arm lost its body");
      }
      const start = record.marks.get(marks.start);
      const end = record.marks.get(marks.end);
      if (start === undefined || end === undefined) continue;
      const renderedMultiline = start.line !== end.line;
      if (renderedMultiline !== this.sourceMultiline(body)) return true;
    }
    return false;
  }

  enableOutcomeSeparation(record: RenderRecord): void {
    for (const [rule, marks] of this.armMarks) {
      const body = this.armBodies.get(rule);
      if (body === undefined) {
        throw new FormatterInvariantError("case arm lost its body");
      }
      const start = record.marks.get(marks.start);
      const end = record.marks.get(marks.end);
      if (start === undefined || end === undefined) {
        this.outcomeMultiline.set(rule, this.sourceMultiline(body));
      } else {
        this.outcomeMultiline.set(rule, start.line !== end.line);
      }
    }
    this.outcomeSeparation = record;
    this.lambdaMarks.clear();
    this.armMarks.clear();
    this.armBodies.clear();
    this.marked.clear();
  }

  /**
   * Whether a rule spans more than one source line, measured to its last
   * content token so layout sentinels never extend the span.
   */
  private sourceMultiline(rule: Rule): boolean {
    const start = lineAtOffset(this.ir.lineStarts, rule.span.start);
    const end = lineAtOffset(
      this.ir.lineStarts,
      Math.max(rule.span.start, this.contentEndOf(rule) - 1),
    );
    return start !== end;
  }

  /** Last content offset, skipping layout sentinels and zero-width tokens. */
  private contentEndOf(rule: Rule): number {
    let end = rule.span.start;
    const stack: Cursor[] = [rule];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (current.type === "token") {
        if (current.kind.startsWith("LAYOUT_")) continue;
        if (current.span.end <= current.span.start) continue;
        if (current.span.end > end) end = current.span.end;
        continue;
      }
      const children = current.children();
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) stack.push(child);
      }
    }
    return end;
  }

  private finishText(rendered: string): string {
    return `${rendered.trimEnd()}\n`;
  }

  private indexLeaves(): void {
    const leaves = this.ir.leaves;
    for (let index = 0; index < leaves.length; index += 1) {
      const leaf = leaves[index];
      if (leaf === undefined) continue;
      let owner: IrNode | null = leaf.owner;
      while (owner !== null) {
        if (!this.firstLeaf.has(owner.rule)) {
          this.firstLeaf.set(owner.rule, index);
        }
        owner = owner.parent;
      }
    }
    for (let index = 0; index < this.ir.trivia.mains.length; index += 1) {
      const trivia = this.ir.trivia.trivia[index];
      if (trivia === undefined) continue;
      this.ownedTrivia.set(index, {
        leading: [...trivia.leading],
        trailing: [...trivia.trailing],
      });
    }
  }

  private collectDroppedTokens(): void {
    const drops = this.ir.dropped;
    const leaves = this.ir.leaves;
    for (const drop of drops) {
      if (
        drop.end === drop.start + 1 &&
        this.ir.source[drop.start] === "("
      ) {
        this.groupingDrops += 1;
      }
      for (let index = 0; index < leaves.length; index += 1) {
        const leaf = leaves[index];
        if (leaf === undefined) continue;
        if (
          leaf.token.span.start >= drop.start &&
          leaf.token.span.end <= drop.end
        ) {
          this.droppedTokens.add(index);
        }
      }
    }
    for (const index of [...this.droppedTokens].sort((a, b) => a - b)) {
      this.redistributeTrivia(index);
    }
  }

  private redistributeTrivia(index: number): void {
    const owned = this.ownedTrivia.get(index);
    if (owned === undefined) return;
    this.ownedTrivia.delete(index);
    if (owned.leading.length > 0) {
      const next = this.nextEmitted(index);
      if (next === null) {
        for (const comment of owned.leading) this.danglingLeading(comment);
      } else {
        const target = this.ownedTrivia.get(next);
        if (target !== undefined) {
          this.ownedTrivia.set(next, {
            leading: [...owned.leading, ...target.leading],
            trailing: target.trailing,
          });
        }
      }
    }
    if (owned.trailing.length > 0) {
      const previous = this.previousEmitted(index);
      if (previous === null) {
        const next = this.nextEmitted(index);
        if (next === null) {
          for (const comment of owned.trailing) this.danglingLeading(comment);
        } else {
          const target = this.ownedTrivia.get(next);
          if (target !== undefined) {
            this.ownedTrivia.set(next, {
              leading: [...owned.trailing, ...target.leading],
              trailing: target.trailing,
            });
          }
        }
      } else {
        const target = this.ownedTrivia.get(previous);
        if (target !== undefined) {
          this.ownedTrivia.set(previous, {
            leading: target.leading,
            trailing: [...target.trailing, ...owned.trailing],
          });
        }
      }
    }
  }

  private readonly extraDangling: TapeComment[] = [];

  private danglingLeading(comment: TapeComment): void {
    this.extraDangling.push(comment);
  }

  private nextEmitted(index: number): number | null {
    for (
      let next = index + 1;
      next < this.ir.leaves.length;
      next += 1
    ) {
      if (!this.droppedTokens.has(next)) return next;
    }
    return null;
  }

  private previousEmitted(index: number): number | null {
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      if (!this.droppedTokens.has(previous)) return previous;
    }
    return null;
  }

  private collectSpacingFlags(): void {
    const stack: IrNode[] = [this.ir.root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      const rule = node.rule;
      if (rule.name === "infix_operation") {
        const operator = directRule(rule, "operator_token");
        if (operator !== null) {
          this.markFirstLeaf(operator, this.spacedOperators);
        }
      }
      if (rule.name === "prefix_operator") {
        this.markFirstLeaf(rule, this.tightPrefixes);
      }
      if (rule.name === "binding_pattern") {
        const qualifier = directRule(rule, "operator_token");
        if (qualifier !== null) {
          this.markFirstLeaf(qualifier, this.tightPrefixes);
        }
      }
      if (rule.name === "field_suffix") {
        this.markFirstLeaf(rule, this.tightDots);
      }
      const children = childRules(rule);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child === undefined) continue;
        const node = this.ir.nodes.get(child);
        if (node !== undefined) stack.push(node);
      }
    }
  }

  private markFirstLeaf(rule: Rule, flags: Set<number>): void {
    const index = this.firstLeaf.get(rule);
    if (index !== undefined) flags.add(index);
  }

  private markTouched(): void {
    if (this.fallback) return;
    const roots: Rule[] = [];
    for (const rule of this.ir.plan.layouts.keys()) roots.push(rule);
    for (const rule of this.ir.plan.scopeTouch) roots.push(rule);
    for (const root of roots) {
      const node = this.ir.nodes.get(root);
      if (node === undefined) continue;
      const stack: IrNode[] = [node];
      while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined) break;
        this.touched.add(current.rule);
        const children = childRules(current.rule);
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const child = children[index];
          if (child === undefined) continue;
          const resolved = this.ir.nodes.get(child);
          if (resolved !== undefined) stack.push(resolved);
        }
      }
    }
  }

  private assignDepths(): void {
    this.depths.set(this.ir.root.rule, 0);
    const stack: IrNode[] = [this.ir.root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      const depth = this.depths.get(node.rule);
      if (depth === undefined) continue;
      for (const child of childRules(node.rule)) {
        const resolved = this.ir.nodes.get(child);
        if (resolved === undefined) continue;
        let childDepth = depth;
        if (this.addsIndent(node.rule, child)) childDepth += 1;
        this.depths.set(child, childDepth);
        stack.push(resolved);
      }
    }
  }

  private addsIndent(parent: Rule, child: Rule): boolean {
    if (
      parent.name === "statement_suite" || parent.name === "do_block"
    ) {
      if (child.type === "rule" && this.isStatementRule(child.name)) {
        return true;
      }
      return false;
    }
    if (parent.name === "case_expression" && child.name === "case_arm") {
      return true;
    }
    if (this.isBrokenValue(parent, child)) return true;
    if (DELIMITED_RULES.has(parent.name) && this.isDelimitedContent(child)) {
      return this.startsOnLaterLine(parent, child);
    }
    if (
      parent.name === "expression" || parent.name === "infix_operation" ||
      parent.name === "continued_expression"
    ) {
      if (!this.startsOnLaterLine(parent, child)) return false;
      return !this.continuesDelimitedBreak(parent);
    }
    if (
      parent.name === "postfix_expression" ||
      parent.name === "continued_postfix_expression"
    ) {
      // Arguments and suffixes always nest: a suffix on its own line
      // detaches below its attachment depth, so flat layout would change
      // the lowered module instead of just restyling it.
      return this.startsOnLaterLine(parent, child);
    }
    if (parent.name === "lambda" || parent.name === "bounded_lambda") {
      return this.isIndentedLambdaBody(parent, child);
    }
    return false;
  }

  /**
   * Whether a child starts on a later source line than its parent. Soft
   * parents (delimited groups, infix chains, applications) indent exactly
   * the children a forced break pushes down, so same-line nesting never
   * accumulates phantom levels and closers dedent to the group-start line.
   * Width-driven group breaks add their level separately (see
   * ensureDelimitedDepths), once the mode is decided.
   */
  private startsOnLaterLine(parent: Rule, child: Rule): boolean {
    return lineAtOffset(this.ir.lineStarts, child.span.start) >
      lineAtOffset(this.ir.lineStarts, parent.span.start);
  }

  /**
   * Whether a soft chain root starts on a continuation line of a delimited
   * group: the same-line ancestor walk ends at a group that broke before
   * the chain. Chains inside broken groups lay flat at the element level
   * (union arms, condition rows); chains starting on their own line nest
   * one level below it.
   */
  private continuesDelimitedBreak(parent: Rule): boolean {
    let root: Rule = parent;
    if (parent.name === "infix_operation") {
      const node = this.ir.nodes.get(parent);
      if (node === undefined || node.parent === null) return false;
      root = node.parent.rule;
    }
    const found = this.ir.nodes.get(root);
    if (found === undefined) return false;
    const line = lineAtOffset(this.ir.lineStarts, root.span.start);
    let current = found.parent;
    while (current !== null) {
      if (
        lineAtOffset(this.ir.lineStarts, current.rule.span.start) !== line
      ) {
        return DELIMITED_RULES.has(current.rule.name);
      }
      current = current.parent;
    }
    return false;
  }

  /**
   * Whether a lambda body sits a level below its arrow, mirroring the
   * retired region rule: the body indents exactly when it starts on a
   * later source line than the last arrow.
   */
  private isIndentedLambdaBody(parent: Rule, child: Rule): boolean {
    let body = directRule(parent, "expression");
    if (body === null) body = directRule(parent, "do_block");
    if (body === null || body !== child) return false;
    const parameters = directRules(parent, "lambda_parameter");
    const last = parameters[parameters.length - 1];
    if (last === undefined) return false;
    const arrow = directToken(last, "=>");
    if (arrow === null) return false;
    return lineAtOffset(this.ir.lineStarts, arrow.span.start) <
      lineAtOffset(this.ir.lineStarts, body.span.start);
  }

  private isStatementRule(name: string): boolean {
    return name === "statement" || name === "declaration";
  }

  /**
   * Whether a rule sits inside delimited content: some ancestor is a
   * delimited group entered through a content child. Element lines take
   * structural indentation so mis-indented groups normalize; preserved
   * source columns survive only for plain continuations.
   */
  private isUnderDelimitedContent(rule: Rule): boolean {
    const found = this.ir.nodes.get(rule);
    let current: IrNode | null = null;
    if (found !== undefined) current = found;
    while (current !== null) {
      const parent = current.parent;
      if (parent === null) return false;
      if (
        DELIMITED_RULES.has(parent.rule.name) &&
        this.isDelimitedContent(current.rule)
      ) {
        return true;
      }
      current = parent;
    }
    return false;
  }

  private isBrokenValue(parent: Rule, value: Rule): boolean {
    if (
      parent.name !== "signature" && parent.name !== "binding" &&
      parent.name !== "result"
    ) {
      return false;
    }
    const direct = directRule(parent, "value");
    if (direct !== null && direct === value) {
      return this.valueBreaks(parent);
    }
    const indented = directRule(parent, "indented_value");
    if (indented !== null && indented === value) {
      return this.valueBreaks(parent);
    }
    if (
      indented !== null && value.span.start >= indented.span.start &&
      value.span.end <= indented.span.end
    ) {
      return this.valueBreaks(parent);
    }
    return false;
  }

  private valueBreaks(statement: Rule): boolean {
    if (this.fallback) return this.sourceValueBroken(statement);
    const layout = this.ir.plan.layouts.get(statement);
    if (layout !== undefined) return layout.kind === "break";
    return this.sourceValueBroken(statement);
  }

  private sourceValueBroken(statement: Rule): boolean {
    let introducer: TokenCursor | null = null;
    if (statement.name === "signature") {
      introducer = directToken(statement, "::");
    } else if (statement.name === "binding") {
      introducer = directToken(statement, "=");
    } else {
      introducer = directToken(statement, "return");
    }
    if (introducer === null) return false;
    const value = directRule(statement, "value");
    const indented = directRule(statement, "indented_value");
    if (indented !== null) return true;
    if (value === null) return false;
    const startLine = lineAtOffset(this.ir.lineStarts, introducer.span.start);
    const valueLine = lineAtOffset(this.ir.lineStarts, value.span.start);
    return startLine !== valueLine;
  }

  private isDelimitedContent(child: Rule): boolean {
    return child.name === "array_element" ||
      child.name === "value" ||
      child.name === "shape_member" ||
      child.name === "shape_spread" ||
      child.name === "shape_field" ||
      child.name === "computed_shape_field" ||
      child.name === "effect_row_part" ||
      child.name === "annotated_pattern" ||
      child.name === "shape_pattern_field";
  }

  private assignPreservedBases(): void {
    const stack: IrNode[] = [this.ir.root];
    const bases: PreservedInfo[] = [];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      while (
        bases.length > 0 &&
        !this.containsRule(
          bases[bases.length - 1]?.node as Rule,
          node.rule,
        )
      ) {
        bases.pop();
      }
      const top = bases[bases.length - 1];
      if (top !== undefined) this.preservedBase.set(node.rule, top.base);
      if (this.hasPreservedFirstLine(node.rule)) {
        const depth = this.depths.get(node.rule);
        const first = this.firstLeaf.get(node.rule);
        if (depth !== undefined && first !== undefined) {
          const leaf = this.ir.leaves[first];
          if (leaf !== undefined) {
            const line = lineAtOffset(
              this.ir.lineStarts,
              leaf.token.span.start,
            );
            bases.push({
              node: node.rule,
              base: { width: this.sourceIndentOf(line), depth },
            });
          }
        }
      }
      const children = childRules(node.rule);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child === undefined) continue;
        const resolved = this.ir.nodes.get(child);
        if (resolved !== undefined) stack.push(resolved);
      }
    }
  }

  private containsRule(outer: Rule, inner: Rule): boolean {
    return inner.span.start >= outer.span.start &&
      inner.span.end <= outer.span.end;
  }

  /**
   * Whether a rule's first printed line keeps its source indent: the
   * rule starts its line (mid-line rules control no indent), the line
   * starts a soft continuation (never a statement, arm, value, tag, or
   * delimited element, whose groups own their vertical layout), and no
   * restructuring touches the path.
   */
  private hasPreservedFirstLine(rule: Rule): boolean {
    if (this.touched.has(rule)) return false;
    if (this.isUnderDelimitedContent(rule)) return false;
    const first = this.firstLeaf.get(rule);
    if (first === undefined) return false;
    if (this.droppedTokens.has(first)) return false;
    if (this.isAnchorToken(first)) return false;
    if (!this.startsItsLine(rule)) return false;
    const firstToken = this.ir.leaves[first];
    let owner: IrNode | null = null;
    if (firstToken !== undefined) owner = firstToken.owner;
    while (owner !== null && owner.rule !== rule) {
      if (this.touched.has(owner.rule)) return false;
      owner = owner.parent;
    }
    return true;
  }

  /**
   * Whether a token starts an anchor line: a declaration, statement, case
   * arm, tag, else clause, or a value broken onto its own line. Anchors
   * always take structural indentation.
   */
  private isAnchorToken(mainIndex: number): boolean {
    const leaf = this.ir.leaves[mainIndex];
    if (leaf === undefined) return false;
    let owner: IrNode | null = leaf.owner;
    while (owner !== null) {
      const rule = owner.rule;
      if (rule.span.start === leaf.token.span.start) {
        if (
          rule.name === "signature" || rule.name === "binding" ||
          rule.name === "result" || rule.name === "rebinding" ||
          rule.name === "sequencing" || rule.name === "iteration" ||
          rule.name === "opening" || rule.name === "breaking" ||
          rule.name === "continuing" || rule.name === "conditional_statement" ||
          rule.name === "declaration_tag" || rule.name === "case_arm" ||
          rule.name === "conditional_statement_else_clause" ||
          rule.name === "conditional_statement_else_if_clause" ||
          rule.name === "declaration" || rule.name === "statement"
        ) {
          return true;
        }
        if (this.isBrokenValueStart(rule, leaf.token.span.start)) return true;
      }
      owner = owner.parent;
    }
    return false;
  }

  private isBrokenValueStart(rule: Rule, tokenStart: number): boolean {
    if (
      rule.name !== "signature" && rule.name !== "binding" &&
      rule.name !== "result"
    ) {
      return false;
    }
    let value = directRule(rule, "value");
    const indented = directRule(rule, "indented_value");
    if (indented !== null) {
      const continued = directRules(indented, "continued_expression")[0];
      if (continued !== undefined) value = continued;
      else {
        const lambda = directRules(indented, "lambda")[0];
        if (lambda !== undefined) value = lambda;
      }
    }
    if (value === null || value.span.start !== tokenStart) return false;
    return this.valueBreaks(rule);
  }

  /**
   * Whether a rule starts at its line's first content: every character
   * between the line start and the rule start is blank.
   */
  private startsItsLine(rule: Rule): boolean {
    const line = lineAtOffset(this.ir.lineStarts, rule.span.start);
    const start = this.ir.lineStarts[line];
    if (start === undefined) return false;
    for (let index = start; index < rule.span.start; index += 1) {
      const char = this.ir.source[index];
      if (char !== " " && char !== "\t") return false;
    }
    return true;
  }

  private sourceIndentOf(line: number): number {
    const start = this.ir.lineStarts[line];
    if (start === undefined) return 0;
    let width = 0;
    while (
      this.ir.source[start + width] === " " ||
      this.ir.source[start + width] === "\t"
    ) {
      width += 1;
    }
    return width;
  }

  /**
   * Builds one document for the whole IR: preserved leading blank lines,
   * the root rule, and trailing dangling comments. Breaks inside carry
   * absolute widths, so the renderer needs no indent stack tracking.
   */
  private buildDocument(): Doc {
    const parts: Doc[] = [];
    const first = this.firstEmittedIndex();
    if (first !== null) {
      const firstLine = this.firstContentLine(first);
      for (let line = 0; line < firstLine; line += 1) {
        if (this.isBlankTextLine(line)) parts.push(hardline());
      }
      this.emitFirstLeading(parts, first);
    }
    parts.push(this.emitRule(this.ir.root.rule));
    this.emitDangling(parts);
    return this.resolveLate(concat(parts));
  }

  /**
   * Resolves every late indent width after the document is built, when all
   * width-driven group modes (and their depth shifts) are final. Bottom-up
   * emission otherwise bakes descendant indents before an ancestor's break
   * shifts them, drifting one level per format. Nodes without late
   * descendants keep their identity, so render marks stay valid.
   */
  private resolveLate(root: Doc): Doc {
    const resolved = new Map<Doc, Doc>();
    const stack: Array<{ readonly node: Doc; readonly expanded: boolean }> = [
      { node: root, expanded: false },
    ];
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame === undefined) break;
      if (resolved.has(frame.node)) continue;
      const node = frame.node;
      if (
        node.kind === "text" || node.kind === "softline" ||
        node.kind === "hardline" || node.kind === "hardlineTo"
      ) {
        resolved.set(node, node);
        continue;
      }
      if (node.kind === "lateHardline") {
        resolved.set(node, hardlineTo(node.resolve()));
        continue;
      }
      if (!frame.expanded) {
        stack.push({ node, expanded: true });
        for (const child of lateChildren(node)) {
          if (!resolved.has(child)) {
            stack.push({ node: child, expanded: false });
          }
        }
        continue;
      }
      resolved.set(node, rebuildLate(node, resolved));
    }
    const result = resolved.get(root);
    if (result === undefined) {
      throw new FormatterInvariantError("indent resolution ran short");
    }
    return result;
  }

  /**
   * Emits the first token's owned leading comments. Every other token's
   * leading comments hoist to its preceding gap, but the first token has
   * no gap, so its comments (and their interior blanks) emit here, before
   * the root rule, or they would silently drop.
   */
  private emitFirstLeading(parts: Doc[], first: number): void {
    const owned = this.ownedTrivia.get(first);
    if (owned === undefined || owned.leading.length === 0) return;
    const leaf = this.ir.leaves[first];
    if (leaf === undefined) return;
    const tokenLine = lineAtOffset(
      this.ir.lineStarts,
      leaf.token.span.start,
    );
    const indent = this.indentForToken(first);
    let previous = -1;
    let emitted = false;
    for (const comment of owned.leading) {
      if (previous >= 0) {
        for (let line = previous + 1; line < comment.line; line += 1) {
          if (this.isBlankTextLine(line)) parts.push(hardline());
        }
      }
      const width = this.commentIndent(indent, comment.line);
      if (emitted) {
        parts.push(hardlineTo(width));
        parts.push(text(comment.text));
      } else {
        parts.push(text(`${" ".repeat(width)}${comment.text}`));
      }
      previous = comment.line;
      emitted = true;
    }
    for (let line = previous + 1; line < tokenLine; line += 1) {
      if (this.isBlankTextLine(line)) parts.push(hardline());
    }
    parts.push(hardlineTo(indent));
  }

  private firstEmittedIndex(): number | null {
    for (let index = 0; index < this.ir.leaves.length; index += 1) {
      if (!this.droppedTokens.has(index)) return index;
    }
    return null;
  }

  /** First content line: the first token or its earliest leading comment. */
  private firstContentLine(index: number): number {
    const leaf = this.ir.leaves[index];
    if (leaf === undefined) return 0;
    let first = lineAtOffset(this.ir.lineStarts, leaf.token.span.start);
    const owned = this.ownedTrivia.get(index);
    if (owned !== undefined) {
      for (const comment of owned.leading) {
        if (comment.line < first) first = comment.line;
      }
    }
    return first;
  }

  private emitDangling(parts: Doc[]): void {
    const comments = [
      ...this.ir.trivia.dangling,
      ...this.extraDangling,
    ].sort((left, right) => left.span.start - right.span.start);
    if (comments.length === 0) return;
    const last = this.lastEmittedIndex();
    let previousLine = -1;
    if (last !== null) {
      const leaf = this.ir.leaves[last];
      if (leaf !== undefined) {
        previousLine = lineAtOffset(
          this.ir.lineStarts,
          leaf.token.span.start,
        );
      }
    }
    for (const comment of comments) {
      for (
        let line = previousLine + 1;
        line < comment.line;
        line += 1
      ) {
        if (this.isBlankTextLine(line)) parts.push(hardline());
      }
      parts.push(hardlineTo(0), text(comment.text));
      previousLine = comment.line;
    }
  }

  private lastEmittedIndex(): number | null {
    for (
      let index = this.ir.leaves.length - 1;
      index >= 0;
      index -= 1
    ) {
      if (!this.droppedTokens.has(index)) return index;
    }
    return null;
  }

  /**
   * Emits one rule bottom-up over an explicit event stack. Token events
   * align with IR leaves in walk order; identity is verified against the
   * leaf spans so frontend drift fails loudly instead of misprinting.
   */
  private emitRule(root: Rule): Doc {
    type Event =
      | { readonly kind: "enter"; readonly rule: Rule }
      | { readonly kind: "exit"; readonly rule: Rule }
      | { readonly kind: "token"; readonly token: TokenCursor };
    const events: Event[] = [{ kind: "enter", rule: root }];
    const stack: Part[][] = [];
    let leafCursor = 0;
    let result: Doc = text("");
    while (events.length > 0) {
      const event = events.pop();
      if (event === undefined) break;
      if (event.kind === "enter") {
        stack.push([]);
        events.push({ kind: "exit", rule: event.rule });
        const children = event.rule.children();
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const child = children[index];
          if (child === undefined) continue;
          if (child.type === "rule") {
            events.push({ kind: "enter", rule: child });
            continue;
          }
          if (child.kind.startsWith("LAYOUT_")) continue;
          if (child.span.end <= child.span.start) continue;
          events.push({ kind: "token", token: child });
        }
        continue;
      }
      if (event.kind === "token") {
        const leaf = this.ir.leaves[leafCursor];
        if (
          leaf === undefined ||
          leaf.token.span.start !== event.token.span.start ||
          leaf.token.text !== event.token.text
        ) {
          throw new FormatterInvariantError(
            "syntax tree order drifted from the token tape",
          );
        }
        const parts = stack[stack.length - 1];
        if (parts === undefined) {
          throw new FormatterInvariantError("printer part stack ran short");
        }
        if (!this.droppedTokens.has(leafCursor)) {
          const doc = this.emitToken(leafCursor);
          this.tokenDocs.set(leafCursor, doc);
          this.firstMemo.set(event.token, leafCursor);
          this.lastMemo.set(event.token, leafCursor);
          this.contentEnds.set(event.token, event.token.span.end);
          parts.push({ child: event.token, doc });
        }
        leafCursor += 1;
        continue;
      }
      const parts = stack.pop();
      if (parts === undefined) {
        throw new FormatterInvariantError("printer part stack ran short");
      }
      const doc = this.finishRule(event.rule, parts);
      const parent = stack[stack.length - 1];
      if (parent === undefined) {
        result = doc;
      } else {
        parent.push({ child: event.rule, doc });
      }
    }
    return result;
  }

  private finishRule(rule: Rule, parts: Part[]): Doc {
    const content = parts.filter((part) => this.hasEmittedContent(part));
    if (rule.name === "array") this.decideArrayMode(rule, content);
    if (
      rule.name === "parenthesized_or_tuple" ||
      rule.name === "tuple_pattern"
    ) {
      this.decideTupleMode(rule, content);
    }
    if (rule.name === "lambda") this.decideLambdaMode(rule);
    const docs: Doc[] = [];
    for (let index = 0; index < content.length; index += 1) {
      const part = content[index];
      if (part === undefined) continue;
      if (index > 0) {
        const previous = content[index - 1];
        if (previous === undefined) continue;
        docs.push(this.gapFor(rule, previous, part));
      }
      docs.push(part.doc);
    }
    this.recordMemos(rule, content);
    return this.wrapRule(rule, content, docs);
  }

  /**
   * Whether a part carries emitted tokens. Rules whose tokens all
   * dropped (a discarded sequencing head) contribute nothing and earn
   * no gaps, so their neighbors join directly.
   */
  private hasEmittedContent(part: Part): boolean {
    const first = this.firstMemo.get(part.child);
    return first !== undefined && first !== null;
  }

  private recordMemos(rule: Rule, parts: Part[]): void {
    if (parts.length === 0) {
      this.firstMemo.set(rule, null);
      this.lastMemo.set(rule, null);
      this.contentEnds.set(rule, rule.span.start);
      this.unjoinableMemo.set(rule, false);
      return;
    }
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (first === undefined || last === undefined) {
      throw new FormatterInvariantError("printer parts ran short");
    }
    const firstIndex = this.firstMemo.get(first.child);
    if (firstIndex === undefined) this.firstMemo.set(rule, null);
    else this.firstMemo.set(rule, firstIndex);
    const lastIndex = this.lastMemo.get(last.child);
    if (lastIndex === undefined) this.lastMemo.set(rule, null);
    else this.lastMemo.set(rule, lastIndex);
    const end = this.contentEnds.get(last.child);
    if (end === undefined) this.contentEnds.set(rule, rule.span.start);
    else this.contentEnds.set(rule, end);
    let unjoinable = false;
    for (const part of parts) {
      if (part.child.type !== "rule") continue;
      if (this.unjoinableMemo.get(part.child) === true) unjoinable = true;
    }
    for (let index = 1; index < parts.length; index += 1) {
      const left = parts[index - 1];
      const right = parts[index];
      if (left === undefined || right === undefined) continue;
      if (this.pairForcesBreak(rule, left.child, right.child)) {
        unjoinable = true;
      }
    }
    this.unjoinableMemo.set(rule, unjoinable);
  }

  private wrapRule(rule: Rule, parts: Part[], docs: Doc[]): Doc {
    if (docs.length === 0) return text("");
    if (rule.name === "array" && this.arrayModes.get(rule) === "group") {
      return group(concat(docs));
    }
    if (
      (rule.name === "parenthesized_or_tuple" ||
        rule.name === "tuple_pattern") &&
      this.tupleModes.get(rule) === "group"
    ) {
      return group(concat(docs));
    }
    if (rule.name === "lambda" && this.lambdaGrouped.has(rule)) {
      const bodyIndex = this.bodyPartIndex(rule, parts);
      const bodyMark = text("");
      if (bodyIndex >= 0) {
        const slot = bodyIndex * 2;
        const bodyDoc = docs[slot];
        if (bodyDoc !== undefined) {
          docs[slot] = concat([bodyMark, bodyDoc]);
        }
      }
      const flat = group(concat(docs));
      this.registerLambdaMarks(rule, bodyMark, flat);
      return flat;
    }
    if (rule.name === "case_arm") this.registerArmMarks(rule, parts, docs);
    return concat(docs);
  }

  /**
   * The arrow mark is the arrow token's own document (its start is the
   * arrow column); the body mark is spliced before the body part so the
   * trigger reads the body's first line exactly. Flat keeps the group
   * node for width introspection.
   */
  private registerLambdaMarks(rule: Rule, bodyMark: Doc, flat: Doc): void {
    const parameters = directRules(rule, "lambda_parameter");
    const last = parameters[parameters.length - 1];
    if (last === undefined) return;
    const arrow = directToken(last, "=>");
    if (arrow === null) return;
    const arrowIndex = this.leafIndexByCursor.get(arrow);
    if (arrowIndex === undefined) return;
    const arrowDoc = this.tokenDocs.get(arrowIndex);
    if (arrowDoc === undefined) return;
    this.lambdaMarks.set(rule, { start: arrowDoc, end: bodyMark, flat });
    this.marked.add(arrowDoc);
    this.marked.add(bodyMark);
  }

  private registerArmMarks(rule: Rule, parts: Part[], docs: Doc[]): void {
    const body = directRule(rule, "value");
    if (body === null) return;
    let bodyIndex = -1;
    for (let index = 0; index < parts.length; index += 1) {
      if (parts[index]?.child === body) bodyIndex = index;
    }
    if (bodyIndex < 0) return;
    const startMark = text("");
    const endMark = text("");
    const slot = bodyIndex * 2;
    const bodyDoc = docs[slot];
    if (bodyDoc === undefined) return;
    docs[slot] = concat([startMark, bodyDoc, endMark]);
    this.armMarks.set(rule, { start: startMark, end: endMark });
    this.armBodies.set(rule, body);
    this.marked.add(startMark);
    this.marked.add(endMark);
  }

  private bodyPartIndex(rule: Rule, parts: Part[]): number {
    let body = directRule(rule, "expression");
    if (body === null) body = directRule(rule, "do_block");
    if (body === null) return -1;
    for (let index = 0; index < parts.length; index += 1) {
      if (parts[index]?.child === body) return index;
    }
    return -1;
  }

  /**
   * Array mode: group decides flat-or-broken by width exactly when the
   * retired loop could normalize the array (no comment inside, every
   * element free of unjoinable breaks); otherwise source breaks stay.
   */
  private decideArrayMode(rule: Rule, parts: Part[]): void {
    if (this.fallback || this.commentsInside(rule)) {
      this.arrayModes.set(rule, "keep");
      return;
    }
    for (const part of parts) {
      if (part.child.type !== "rule") continue;
      if (this.unjoinableMemo.get(part.child) === true) {
        this.arrayModes.set(rule, "keep");
        return;
      }
    }
    if (this.arrayJoinExceedsLine(rule)) {
      this.arrayModes.set(rule, "keep");
      return;
    }
    this.arrayModes.set(rule, "group");
    this.ensureDelimitedDepths(rule);
  }

  /**
   * Whether joining a broken array would overflow its line: the joined
   * width counts the source prefix, the flattened elements, and the
   * trailing suffix exactly as the width rule measures them. A join past
   * 80 columns keeps its source breaks instead. Flat check only fires for
   * broken source; flat source groups decide by render width as usual.
   */
  private arrayJoinExceedsLine(rule: Rule): boolean {
    const contentEnd = this.contentEndOf(rule);
    const original = this.ir.source.slice(rule.span.start, contentEnd);
    if (!original.includes("\n")) return false;
    const elements: string[] = [];
    for (const child of childRules(rule)) {
      if (child.name !== "array_element") continue;
      const end = this.contentEndOf(child);
      const text = this.ir.source.slice(child.span.start, end);
      elements.push(text.replace(/\s+/g, " ").trim());
    }
    if (elements.length === 0) return false;
    const flat = `[${elements.join(", ")}]`;
    const line = lineAtOffset(this.ir.lineStarts, rule.span.start);
    const lineStart = this.ir.lineStarts[line];
    if (lineStart === undefined) return false;
    const prefix = rule.span.start - lineStart;
    let lineEnd = this.ir.source.indexOf("\n", contentEnd);
    if (lineEnd < 0) lineEnd = this.ir.source.length;
    const suffix = this.ir.source.slice(contentEnd, lineEnd);
    if (prefix + flat.length + suffix.length <= this.width) {
      return false;
    }
    let effective = prefix;
    const first = this.firstLeaf.get(rule);
    if (first !== undefined && !this.droppedTokens.has(first)) {
      const indent = this.indentForToken(first);
      if (indent > effective) effective = indent;
    }
    return flat.length <= this.width - effective;
  }

  /**
   * Adds the content level a width-driven group break owns. Source-joined
   * elements carry no static indent; when the group breaks (or rebreaks),
   * every element line nests one level below the opener. The shift lands
   * before any ancestor gap reads these depths, and nested groups compose
   * because each shift moves whole subtrees uniformly.
   */
  private ensureDelimitedDepths(rule: Rule): void {
    if (this.shiftedDelimiters.has(rule)) return;
    this.shiftedDelimiters.add(rule);
    for (const child of childRules(rule)) {
      if (!this.isDelimitedContent(child)) continue;
      if (this.startsOnLaterLine(rule, child)) continue;
      this.shiftSubtreeDepth(child, 1);
    }
  }

  private shiftSubtreeDepth(root: Rule, delta: number): void {
    const stack: Rule[] = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      const depth = this.depths.get(current);
      if (depth === undefined) {
        throw new FormatterInvariantError("printer depth is missing");
      }
      this.depths.set(current, depth + delta);
      for (const child of childRules(current)) stack.push(child);
    }
  }

  /**
   * Tuple mode, ported from the retired tuple helper: short, already
   * vertical, single, or comment-carrying tuples keep their shape; flat
   * tuples fit by width; other multiline tuples rebreak one value per
   * line. Groupings (no comma) always keep.
   */
  private decideTupleMode(rule: Rule, parts: Part[]): void {
    let commas = 0;
    let values = 0;
    for (const part of parts) {
      if (part.child.type === "token") {
        if (part.child.text === ",") commas += 1;
        continue;
      }
      values += 1;
    }
    if (commas === 0 || values < 2 || this.fallback) {
      this.tupleModes.set(rule, "keep");
      return;
    }
    if (this.commentsInside(rule)) {
      this.tupleModes.set(rule, "keep");
      return;
    }
    const original = this.ir.source.slice(
      rule.span.start,
      this.contentEndOf(rule),
    );
    if (this.flattenedLength(original) < 40) {
      this.tupleModes.set(rule, "keep");
      return;
    }
    if (
      this.ir.source[rule.span.start] === "(" &&
      this.ir.source[rule.span.start + 1] === "\n"
    ) {
      this.tupleModes.set(rule, "keep");
      return;
    }
    if (original.includes("\n")) {
      this.tupleModes.set(rule, "rebreak");
      this.ensureDelimitedDepths(rule);
    } else {
      this.tupleModes.set(rule, "group");
      this.ensureDelimitedDepths(rule);
    }
  }

  /**
   * Lambda mode: group flattens or poison-breaks exactly when the retired
   * helper would attempt the lambda (no comment inside, no
   * layout-sensitive rule in the body). Anything else keeps its shape.
   * Bounded lambdas always keep: the retired helper never collected them.
   */
  private decideLambdaMode(rule: Rule): void {
    if (this.fallback || this.commentsInside(rule)) return;
    const body = directRule(rule, "expression");
    if (body === null) return;
    if (this.containsLayoutSensitive(body)) return;
    this.lambdaGrouped.add(rule);
  }

  private containsLayoutSensitive(rule: Rule): boolean {
    const stack: Rule[] = [rule];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      if (LAYOUT_SENSITIVE_RULES.has(current.name)) return true;
      const children = childRules(current);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) stack.push(child);
      }
    }
    return false;
  }

  /** Whether any comment token sits within a rule's span. */
  private commentsInside(rule: Rule): boolean {
    const memo = this.commentInsideMemo.get(rule);
    if (memo !== undefined) return memo;
    let found = false;
    for (const comment of this.ir.trivia.comments) {
      if (
        comment.span.start >= rule.span.start &&
        comment.span.end <= rule.span.end
      ) {
        found = true;
        break;
      }
    }
    this.commentInsideMemo.set(rule, found);
    return found;
  }

  /**
   * Flattened content length without building the string: blank runs
   * around newlines collapse to one space, outer blanks trim away.
   */
  private flattenedLength(original: string): number {
    let length = 0;
    let index = 0;
    while (index < original.length && isBlankChar(original[index])) {
      index += 1;
    }
    let pendingSpace = false;
    for (; index < original.length; index += 1) {
      const char = original[index];
      if (char === "\n" || char === "\r") {
        pendingSpace = true;
        continue;
      }
      if (isBlankChar(char)) {
        if (pendingSpace) continue;
        if (this.blanksToNewline(original, index)) continue;
        length += 1;
        continue;
      }
      if (pendingSpace) {
        if (length > 0) length += 1;
        pendingSpace = false;
      }
      length += 1;
    }
    return length;
  }

  /** Whether blanks from index run to a newline or the string end. */
  private blanksToNewline(original: string, index: number): boolean {
    for (let rest = index + 1; rest < original.length; rest += 1) {
      const next = original[rest];
      if (next === "\n" || next === "\r") return true;
      if (!isBlankChar(next)) return false;
    }
    return true;
  }

  /**
   * Classifies the gap between two adjacent emitted children. The same
   * classification drives emission and the joinability memo so the two
   * can never drift apart.
   */
  private classifyGap(
    parent: Rule,
    left: Cursor,
    right: Cursor,
  ): GapKind {
    if (parent.name === "program") {
      if (isDeclaration(left) && isDeclaration(right)) return "sibling";
      return "forced";
    }
    if (parent.name === "statement_suite" || parent.name === "do_block") {
      if (isStatementCursor(left) && isStatementCursor(right)) {
        return "sibling";
      }
      return "keep";
    }
    if (parent.name === "case_expression") {
      if (isCaseArm(left) && isCaseArm(right)) return "arm";
      return "keep";
    }
    if (parent.name === "conditional_statement_branches") {
      if (isElseClause(right)) return "else";
      return "keep";
    }
    if (
      parent.name === "signature" || parent.name === "binding" ||
      parent.name === "result"
    ) {
      if (this.isIntroducerGap(parent, left, right)) return "introducer";
      return "keep";
    }
    if (parent.name === "lambda" || parent.name === "bounded_lambda") {
      if (this.isArrowGap(parent, left, right)) return "arrow";
      return "keep";
    }
    if (parent.name === "array") return "delimited";
    if (
      parent.name === "parenthesized_or_tuple" ||
      parent.name === "tuple_pattern"
    ) {
      return "delimited";
    }
    return "keep";
  }

  /**
   * Whether a gap always breaks in the output, used for the joinability
   * memo. Group-decided gaps join under a flat enclosing group; every
   * other broken gap is unjoinable.
   */
  private pairForcesBreak(
    parent: Rule,
    left: Cursor,
    right: Cursor,
  ): boolean {
    const first = this.firstMemo.get(right);
    if (first !== undefined && first !== null) {
      const owned = this.ownedTrivia.get(first);
      if (owned !== undefined && owned.leading.length > 0) return true;
    }
    const kind = this.classifyGap(parent, left, right);
    if (kind === "sibling" || kind === "arm" || kind === "else") return true;
    if (kind === "forced") return true;
    if (kind === "introducer") {
      if (this.fallback) return this.keepPairBreaks(left, right);
      const layout = this.ir.plan.layouts.get(parent);
      if (layout === undefined) return this.keepPairBreaks(left, right);
      if (layout.kind === "break") return true;
      if (layout.kind === "join") return false;
      return this.keepPairBreaks(left, right);
    }
    if (kind === "arrow") {
      if (this.fallback) return this.keepPairBreaks(left, right);
      if (this.lambdaGrouped.has(parent)) return false;
      return this.keepPairBreaks(left, right);
    }
    if (kind === "delimited") {
      const mode = this.delimitedMode(parent);
      if (mode === "group") return false;
      if (mode === "rebreak") return this.delimitedPairBreaks(right);
      return this.keepPairBreaks(left, right);
    }
    return this.keepPairBreaks(left, right);
  }

  private delimitedMode(parent: Rule): "group" | "keep" | "rebreak" {
    if (parent.name === "array") {
      const mode = this.arrayModes.get(parent);
      if (mode === undefined) {
        throw new FormatterInvariantError("array mode was not decided");
      }
      return mode;
    }
    const mode = this.tupleModes.get(parent);
    if (mode === undefined) {
      throw new FormatterInvariantError("tuple mode was not decided");
    }
    return mode;
  }

  /**
   * Whether a rebreak pair breaks: every pair in a rebroken tuple breaks
   * except the tight gap before a comma.
   */
  private delimitedPairBreaks(right: Cursor): boolean {
    if (right.type === "token" && right.text === ",") return false;
    return true;
  }

  /** Whether a keep pair spans a source line break. */
  private keepPairBreaks(left: Cursor, right: Cursor): boolean {
    const lastIndex = this.lastMemo.get(left);
    const firstIndex = this.firstMemo.get(right);
    if (lastIndex === undefined || lastIndex === null) return false;
    if (firstIndex === undefined || firstIndex === null) return false;
    const lastLeaf = this.ir.leaves[lastIndex];
    const firstLeaf = this.ir.leaves[firstIndex];
    if (lastLeaf === undefined || firstLeaf === undefined) return false;
    const lastLine = lineAtOffset(
      this.ir.lineStarts,
      Math.max(
        lastLeaf.token.span.start,
        lastLeaf.token.span.end - 1,
      ),
    );
    const firstLine = lineAtOffset(
      this.ir.lineStarts,
      firstLeaf.token.span.start,
    );
    return lastLine !== firstLine;
  }

  private isIntroducerGap(
    parent: Rule,
    left: Cursor,
    right: Cursor,
  ): boolean {
    if (right.type !== "rule") return false;
    if (right.name !== "value" && right.name !== "indented_value") {
      return false;
    }
    if (left.type !== "token") return false;
    if (parent.name === "signature") return left.text === "::";
    if (parent.name === "binding") return left.text === "=";
    return left.text === "return";
  }

  private isArrowGap(parent: Rule, left: Cursor, right: Cursor): boolean {
    if (right.type !== "rule") return false;
    if (right.name !== "expression" && right.name !== "do_block") {
      return false;
    }
    if (left.type !== "rule" || left.name !== "lambda_parameter") return false;
    void parent;
    return true;
  }

  private gapFor(parent: Rule, left: Part, right: Part): Doc {
    const kind = this.classifyGap(parent, left.child, right.child);
    if (kind === "sibling") {
      return this.siblingGap(left.child, right.child);
    }
    if (kind === "arm") return this.armGap(left.child, right.child);
    if (kind === "else") return this.elseGap(left.child, right.child);
    if (kind === "forced") return this.preserveGap(left.child, right.child);
    if (kind === "introducer") {
      return this.introducerGap(parent, left.child, right.child);
    }
    if (kind === "arrow") return this.arrowGap(parent, left.child, right.child);
    if (kind === "delimited") {
      return this.delimitedGap(parent, left.child, right.child);
    }
    return this.keepGap(left.child, right.child);
  }

  /**
   * Sibling gap between adjacent declarations or statements. Separation
   * wins over joining; otherwise source blanks stay as they are.
   */
  private siblingGap(left: Cursor, right: Cursor): Doc {
    if (isSibling(left) && isSibling(right)) {
      if (this.separatesSiblings(left, right)) {
        return concat(
          this.leadingDocs(right, () => this.indentForChild(right), [
            hardline(),
          ]),
        );
      }
      if (this.joinsSiblings(left, right)) {
        return concat(
          this.leadingDocs(right, () => this.indentForChild(right), []),
        );
      }
    }
    return this.preserveGap(left, right);
  }

  private separatesSiblings(left: Rule, right: Rule): boolean {
    if (this.suiteAfter(left)) return true;
    const currentKind = recursiveBindingKind(left);
    if (currentKind === null) return false;
    return recursiveDeclarationKind(right) !== currentKind;
  }

  private joinsSiblings(left: Rule, right: Rule): boolean {
    if (
      directRule(left, "signature") !== null &&
      directRule(right, "binding") !== null
    ) {
      return true;
    }
    const currentKind = recursiveBindingKind(left);
    if (currentKind === null) return false;
    return recursiveDeclarationKind(right) === currentKind;
  }

  /** Whether a sibling directly contains a suite statement. */
  private suiteAfter(rule: Rule): boolean {
    for (const child of rule.children()) {
      if (child.type === "rule" && SUITE_STATEMENT_RULES.has(child.name)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Arm gap: a blank line follows a multiline arm body, decided from the
   * source on the first render and from the measuring render on rebuild.
   * Stray source blanks between single-line arms stay as they are.
   */
  private armGap(left: Cursor, right: Cursor): Doc {
    if (left.type !== "rule") return this.preserveGap(left, right);
    const body = directRule(left, "value");
    let multiline = false;
    if (body !== null) {
      if (this.outcomeSeparation === null) {
        multiline = this.sourceMultiline(body);
      } else {
        const outcome = this.outcomeMultiline.get(left);
        if (outcome === undefined) multiline = this.sourceMultiline(body);
        else multiline = outcome;
      }
    }
    if (multiline) {
      return concat(this.leadingDocs(right, () => this.indentForChild(right), [
        hardline(),
      ]));
    }
    return this.preserveGap(left, right);
  }

  /**
   * Gap before an else-if or else clause: source blanks stay except the
   * blank line directly above the clause, which the retired pre-pass
   * stripped exactly once.
   */
  private elseGap(left: Cursor, right: Cursor): Doc {
    const lastIndex = this.lastMemo.get(left);
    const firstIndex = this.firstMemo.get(right);
    if (lastIndex === undefined || lastIndex === null) {
      return this.keepGap(left, right);
    }
    if (firstIndex === undefined || firstIndex === null) {
      return this.keepGap(left, right);
    }
    const lastLeaf = this.ir.leaves[lastIndex];
    const firstLeaf = this.ir.leaves[firstIndex];
    if (lastLeaf === undefined || firstLeaf === undefined) {
      return this.keepGap(left, right);
    }
    const endLine = lineAtOffset(
      this.ir.lineStarts,
      Math.max(
        lastLeaf.token.span.start,
        lastLeaf.token.span.end - 1,
      ),
    );
    const elseLine = lineAtOffset(
      this.ir.lineStarts,
      firstLeaf.token.span.start,
    );
    const before: Doc[] = [];
    const firstContent = this.firstContentIndex(firstIndex);
    for (let line = endLine + 1; line < firstContent; line += 1) {
      if (line === elseLine - 1 && line > endLine) continue;
      if (this.isBlankTextLine(line)) before.push(hardline());
    }
    return concat(
      this.leadingDocs(right, () => this.indentForToken(firstIndex), before),
    );
  }

  /**
   * Break gap that preserves every source blank line between two
   * children: the default for sibling-shaped pairs with no rule.
   */
  private preserveGap(left: Cursor, right: Cursor): Doc {
    const lastIndex = this.lastMemo.get(left);
    const firstIndex = this.firstMemo.get(right);
    if (lastIndex === undefined || lastIndex === null) return text(" ");
    if (firstIndex === undefined || firstIndex === null) return text(" ");
    const lastLeaf = this.ir.leaves[lastIndex];
    if (lastLeaf === undefined) return text(" ");
    const endLine = lineAtOffset(
      this.ir.lineStarts,
      Math.max(
        lastLeaf.token.span.start,
        lastLeaf.token.span.end - 1,
      ),
    );
    const before: Doc[] = [];
    const firstContent = this.firstContentIndex(firstIndex);
    for (let line = endLine + 1; line < firstContent; line += 1) {
      if (this.isBlankTextLine(line)) before.push(hardline());
    }
    return concat(
      this.leadingDocs(right, () => this.indentForToken(firstIndex), before),
    );
  }

  private introducerGap(parent: Rule, left: Cursor, right: Cursor): Doc {
    if (!this.fallback) {
      const layout = this.ir.plan.layouts.get(parent);
      if (layout !== undefined && layout.kind === "join") return text(" ");
      if (layout !== undefined && layout.kind === "break") {
        const firstIndex = this.firstMemo.get(right);
        if (firstIndex === undefined || firstIndex === null) {
          return text(" ");
        }
        return concat(
          this.leadingDocs(right, () => this.indentForToken(firstIndex), []),
        );
      }
    }
    return this.keepGap(left, right);
  }

  private arrowGap(parent: Rule, left: Cursor, right: Cursor): Doc {
    if (!this.fallback && this.lambdaGrouped.has(parent)) {
      const firstIndex = this.firstMemo.get(right);
      if (firstIndex === undefined || firstIndex === null) return text(" ");
      const owned = this.ownedTrivia.get(firstIndex);
      if (owned !== undefined && owned.leading.length > 0) {
        return concat(
          this.leadingDocs(right, () => this.indentForToken(firstIndex), []),
        );
      }
      const space = this.spaceForGap(left, right);
      return ifBreak(
        lateHardline(() => this.indentForToken(firstIndex)),
        text(space),
      );
    }
    return this.keepGap(left, right);
  }

  private delimitedGap(parent: Rule, left: Cursor, right: Cursor): Doc {
    const mode = this.delimitedMode(parent);
    if (mode === "group") return this.groupDelimitedGap(parent, left, right);
    if (mode === "rebreak") {
      return this.rebreakDelimitedGap(parent, left, right);
    }
    return this.keepGap(left, right);
  }

  /**
   * Width-decided bracket gaps: opening and closing breaks carry the
   * content and bracket depths, separators the content depth. Leading
   * comments force the break defensively; the span checks rule them out.
   */
  private groupDelimitedGap(
    parent: Rule,
    left: Cursor,
    right: Cursor,
  ): Doc {
    void parent;
    if (right.type === "token" && right.text === ",") return text("");
    const firstIndex = this.firstMemo.get(right);
    if (firstIndex === undefined || firstIndex === null) return text("");
    const owned = this.ownedTrivia.get(firstIndex);
    if (owned !== undefined && owned.leading.length > 0) {
      return concat(
        this.leadingDocs(right, () => this.indentForToken(firstIndex), []),
      );
    }
    const indent = () => this.indentForToken(firstIndex);
    if (left.type === "token" && isOpenBracket(left.text)) {
      return ifBreak(lateHardline(indent), text(""));
    }
    if (right.type === "token" && isCloseBracket(right.text)) {
      return ifBreak(lateHardline(indent), text(""));
    }
    if (left.type === "token" && left.text === ",") {
      return ifBreak(lateHardline(indent), text(" "));
    }
    return this.keepGap(left, right);
  }

  /**
   * Eager one-value-per-line gaps for multiline tuples the retired
   * helper rebroke. Nested groups inside values still decide freely.
   */
  private rebreakDelimitedGap(
    parent: Rule,
    left: Cursor,
    right: Cursor,
  ): Doc {
    void parent;
    void left;
    if (right.type === "token" && right.text === ",") return text("");
    const firstIndex = this.firstMemo.get(right);
    if (firstIndex === undefined || firstIndex === null) return text("");
    return concat(
      this.leadingDocs(right, () => this.indentForToken(firstIndex), []),
    );
  }

  /**
   * Keep gap: same-line pairs take horizontal spacing; broken pairs
   * keep their blanks and break, joining to a space when an enclosing
   * group renders flat.
   */
  private keepGap(left: Cursor, right: Cursor): Doc {
    const space = this.spaceForGap(left, right);
    const lastIndex = this.lastMemo.get(left);
    const firstIndex = this.firstMemo.get(right);
    if (lastIndex === undefined || lastIndex === null) return text(space);
    if (firstIndex === undefined || firstIndex === null) return text(space);
    const lastLeaf = this.ir.leaves[lastIndex];
    const firstLeaf = this.ir.leaves[firstIndex];
    if (lastLeaf === undefined || firstLeaf === undefined) {
      return text(space);
    }
    const lastLine = lineAtOffset(
      this.ir.lineStarts,
      Math.max(
        lastLeaf.token.span.start,
        lastLeaf.token.span.end - 1,
      ),
    );
    const firstLine = lineAtOffset(
      this.ir.lineStarts,
      firstLeaf.token.span.start,
    );
    if (lastLine === firstLine) return text(space);
    const before: Doc[] = [];
    const firstContent = this.firstContentIndex(firstIndex);
    for (let line = lastLine + 1; line < firstContent; line += 1) {
      if (this.isBlankTextLine(line)) before.push(hardline());
    }
    return ifBreak(
      concat(
        this.leadingDocs(right, () => this.indentForToken(firstIndex), before),
      ),
      text(space),
    );
  }

  /**
   * First content line of a token: its own line or its earliest owned
   * leading comment, so blank runs stop at comments.
   */
  private firstContentIndex(index: number): number {
    const leaf = this.ir.leaves[index];
    if (leaf === undefined) return 0;
    let first = lineAtOffset(this.ir.lineStarts, leaf.token.span.start);
    const owned = this.ownedTrivia.get(index);
    if (owned !== undefined) {
      for (const comment of owned.leading) {
        if (comment.line < first) first = comment.line;
      }
    }
    return first;
  }

  /**
   * Emits the break prelude before a token: caller blanks, then each
   * owned leading comment on its own indented line with preserved
   * interior blanks, then the final break to the token indent. Widths
   * resolve after the document is built, once width-driven group breaks
   * have settled every depth.
   */
  private leadingDocs(
    right: Cursor,
    indent: () => number,
    before: Doc[],
  ): Doc[] {
    const docs = [...before];
    const firstIndex = this.firstMemo.get(right);
    if (firstIndex === undefined || firstIndex === null) {
      docs.push(lateHardline(indent));
      return docs;
    }
    const owned = this.ownedTrivia.get(firstIndex);
    if (owned === undefined || owned.leading.length === 0) {
      docs.push(lateHardline(indent));
      return docs;
    }
    const leaf = this.ir.leaves[firstIndex];
    if (leaf === undefined) {
      docs.push(lateHardline(indent));
      return docs;
    }
    const tokenLine = lineAtOffset(
      this.ir.lineStarts,
      leaf.token.span.start,
    );
    let previous = -1;
    for (const comment of owned.leading) {
      if (previous >= 0) {
        for (let line = previous + 1; line < comment.line; line += 1) {
          if (this.isBlankTextLine(line)) docs.push(hardline());
        }
      }
      const commentLine = comment.line;
      docs.push(lateHardline(() => this.commentIndent(indent(), commentLine)));
      docs.push(text(comment.text));
      previous = comment.line;
    }
    for (let line = previous + 1; line < tokenLine; line += 1) {
      if (this.isBlankTextLine(line)) docs.push(hardline());
    }
    docs.push(lateHardline(indent));
    return docs;
  }

  /**
   * Leading-comment indent: the following token's line indent, except in
   * fallback where comments keep their own source columns like the
   * retired trim-only path.
   */
  private commentIndent(indent: number, line: number): number {
    if (this.fallback) return this.sourceIndentOf(line);
    return indent;
  }

  /**
   * Emits one token verbatim with its owned trailing comments as a line
   * suffix. Leading comments hoist to the preceding gap so group
   * flatness never depends on them.
   */
  private emitToken(index: number): Doc {
    const leaf = this.ir.leaves[index];
    if (leaf === undefined) {
      throw new FormatterInvariantError("printer leaf is missing");
    }
    const docs: Doc[] = [text(leaf.token.text)];
    const owned = this.ownedTrivia.get(index);
    if (owned !== undefined) {
      for (const comment of owned.trailing) {
        docs.push(
          lineSuffix(
            text(`${this.trailingGap(leaf.token, comment)}${comment.text}`),
          ),
        );
      }
    }
    if (docs.length === 1) {
      const only = docs[0];
      if (only === undefined) {
        throw new FormatterInvariantError("printer token doc is missing");
      }
      return only;
    }
    return concat(docs);
  }

  /**
   * Gap before a trailing comment: the source gap verbatim when it is
   * blank-only (the retired spacing pass never touched comment pairs),
   * otherwise a single space.
   */
  private trailingGap(token: TokenCursor, comment: TapeComment): string {
    const gap = this.ir.source.slice(token.span.end, comment.span.start);
    for (let index = 0; index < gap.length; index += 1) {
      const char = gap[index];
      if (char !== " " && char !== "\t") return " ";
    }
    return gap;
  }

  /**
   * Horizontal spacing between two same-line tokens, ported from the
   * retired spacing pass: keyword, operator, and punctuation rules apply
   * in order, then the tight rules, then the empty-shape rule. Records
   * whether any blank source gap changed.
   */
  private spaceForGap(left: Cursor, right: Cursor): string {
    const lastIndex = this.lastMemo.get(left);
    const firstIndex = this.firstMemo.get(right);
    if (lastIndex === undefined || lastIndex === null) return " ";
    if (firstIndex === undefined || firstIndex === null) return " ";
    const lastLeaf = this.ir.leaves[lastIndex];
    const firstLeaf = this.ir.leaves[firstIndex];
    if (lastLeaf === undefined || firstLeaf === undefined) return " ";
    const prev = lastLeaf.token;
    const cur = firstLeaf.token;
    const gap = this.ir.source.slice(prev.span.end, cur.span.start);
    let space = "";
    if (gap.length > 0) space = " ";
    if (KEYWORDS.has(prev.text)) space = " ";
    if (
      prev.text === "," || prev.text === ";" || prev.text === "{" ||
      cur.text === "}"
    ) {
      space = " ";
    }
    if (
      OPERATORS.has(prev.text) || OPERATORS.has(cur.text) ||
      this.spacedOperators.has(lastIndex) ||
      this.spacedOperators.has(firstIndex) ||
      this.gapStartsArgument(prev, firstLeaf)
    ) {
      space = " ";
    }
    if (
      TIGHT_RIGHT.has(cur.text) || TIGHT_LEFT.has(prev.text) ||
      this.tightDots.has(firstIndex) || this.tightPrefixes.has(lastIndex)
    ) {
      space = "";
    }
    if (prev.text === "{" && cur.text === "}") space = "";
    if (this.isBlankGap(gap) && gap !== space) this.spacingChanged = true;
    return space;
  }

  /**
   * Whether the gap starts an application argument: the nearest argument
   * ancestor of the current token begins at or after the previous token
   * ends, so dropped grouping delimiters cannot hide the boundary.
   */
  private gapStartsArgument(
    prev: TokenCursor,
    firstLeaf: IrToken,
  ): boolean {
    let owner: IrNode | null = firstLeaf.owner;
    while (owner !== null) {
      if (owner.rule.name === "application_argument") {
        return owner.rule.span.start >= prev.span.end;
      }
      owner = owner.parent;
    }
    return false;
  }

  private isBlankGap(gap: string): boolean {
    for (let index = 0; index < gap.length; index += 1) {
      const char = gap[index];
      if (char !== " " && char !== "\t") return false;
    }
    return true;
  }

  /** Whether a source line holds only whitespace. */
  private isBlankTextLine(line: number): boolean {
    const starts = this.ir.lineStarts;
    const start = starts[line];
    if (start === undefined) return false;
    let end = starts[line + 1];
    if (end === undefined) end = this.ir.source.length;
    for (let index = start; index < end; index += 1) {
      const char = this.ir.source[index];
      if (
        char !== " " && char !== "\t" && char !== "\r" && char !== "\n"
      ) {
        return false;
      }
    }
    return true;
  }

  private indentForChild(child: Cursor): number {
    const firstIndex = this.firstMemo.get(child);
    if (firstIndex === undefined || firstIndex === null) return 0;
    return this.indentForToken(firstIndex);
  }

  /**
   * Absolute indent width for the line starting at a token. Fallback
   * keeps every source column; otherwise preserved first lines keep
   * their source width, anchors under a preserved base shift relatively,
   * and everything else takes structural depth.
   */
  private indentForToken(index: number): number {
    const leaf = this.ir.leaves[index];
    if (leaf === undefined) return 0;
    const line = lineAtOffset(this.ir.lineStarts, leaf.token.span.start);
    if (this.fallback) return this.sourceIndentOf(line);
    const caseIndent = this.caseOfIndent(index);
    if (caseIndent !== null) return caseIndent;
    const rule = this.lineStartRule(leaf);
    const depth = this.depths.get(rule);
    if (depth === undefined) {
      throw new FormatterInvariantError("printer depth is missing");
    }
    if (
      rule.span.start === leaf.token.span.start &&
      this.hasPreservedFirstLine(rule)
    ) {
      return this.sourceIndentOf(line);
    }
    const base = this.preservedBase.get(rule);
    if (base === undefined) return depth * 2;
    return base.width + (depth - base.depth) * 2;
  }

  /**
   * The rule deciding a line's indent: the token's innermost owner,
   * which is the deepest rule starting at the token, or the owning
   * delimited rule for closers that start no rule.
   */
  private lineStartRule(leaf: IrToken): Rule {
    return leaf.owner.rule;
  }

  /**
   * Indent for a closer line that carries the case `of`: a broken
   * scrutinee's `of` aligns with the case arms, one level below the case.
   * The closer and `of` share their source line, so no comment can split
   * them and they stay on one output line.
   */
  private caseOfIndent(index: number): number | null {
    const leaf = this.ir.leaves[index];
    if (leaf === undefined) return null;
    if (
      leaf.token.text !== ")" && leaf.token.text !== "]" &&
      leaf.token.text !== "}"
    ) {
      return null;
    }
    const next = this.nextEmitted(index);
    if (next === null) return null;
    const following = this.ir.leaves[next];
    if (following === undefined || following.token.text !== "of") return null;
    if (
      lineAtOffset(this.ir.lineStarts, following.token.span.start) !==
        lineAtOffset(this.ir.lineStarts, leaf.token.span.start)
    ) {
      return null;
    }
    let owner: IrNode | null = following.owner;
    while (owner !== null) {
      if (owner.rule.name === "case_expression") {
        const depth = this.depths.get(owner.rule);
        if (depth === undefined) {
          throw new FormatterInvariantError("printer depth is missing");
        }
        return (depth + 1) * 2;
      }
      owner = owner.parent;
    }
    return null;
  }

  /**
   * Poison-discard trigger: a grouped lambda whose body renders below
   * its arrow broke a layout the grammar rejects (breaking after `=>`
   * is invalid source), so the whole render is discarded for fallback.
   * The retired loop reached the same outcome by reverting poisoned
   * layouts; measuring it here costs one record scan, no parse.
   */
  findLambdaTrigger(record: RenderRecord): Rule | null {
    for (const [rule, marks] of this.lambdaMarks) {
      const start = record.marks.get(marks.start);
      const end = record.marks.get(marks.end);
      if (start === undefined || end === undefined) continue;
      if (end.line > start.line) return rule;
    }
    return null;
  }
}

interface Part {
  readonly child: Cursor;
  readonly doc: Doc;
}

function lateChildren(node: Doc): readonly Doc[] {
  if (node.kind === "concat") return node.parts;
  if (node.kind === "group" || node.kind === "indent") return [node.body];
  if (node.kind === "ifBreak") return [node.broken, node.flat];
  if (node.kind === "lineSuffix") return [node.body];
  return [];
}

function rebuildLate(node: Doc, resolved: ReadonlyMap<Doc, Doc>): Doc {
  if (node.kind === "concat") {
    let changed = false;
    const parts: Doc[] = [];
    for (const part of node.parts) {
      const next = resolved.get(part);
      if (next === undefined) {
        throw new FormatterInvariantError("indent resolution ran short");
      }
      if (next !== part) changed = true;
      parts.push(next);
    }
    if (!changed) return node;
    return concat(parts);
  }
  if (node.kind === "group" || node.kind === "indent") {
    const body = resolved.get(node.body);
    if (body === undefined) {
      throw new FormatterInvariantError("indent resolution ran short");
    }
    if (body === node.body) return node;
    if (node.kind === "group") return group(body);
    return indent(body);
  }
  if (node.kind === "ifBreak") {
    const broken = resolved.get(node.broken);
    const flat = resolved.get(node.flat);
    if (broken === undefined || flat === undefined) {
      throw new FormatterInvariantError("indent resolution ran short");
    }
    if (broken === node.broken && flat === node.flat) return node;
    return ifBreak(broken, flat);
  }
  if (node.kind === "lineSuffix") {
    const body = resolved.get(node.body);
    if (body === undefined) {
      throw new FormatterInvariantError("indent resolution ran short");
    }
    if (body === node.body) return node;
    return lineSuffix(body);
  }
  return node;
}

type GapKind =
  | "sibling"
  | "arm"
  | "else"
  | "forced"
  | "introducer"
  | "arrow"
  | "delimited"
  | "keep";

function isDeclaration(cursor: Cursor): cursor is Rule {
  return cursor.type === "rule" && cursor.name === "declaration";
}

function isSibling(cursor: Cursor): cursor is Rule {
  return cursor.type === "rule" &&
    (cursor.name === "declaration" || cursor.name === "statement");
}

function isStatementCursor(cursor: Cursor): boolean {
  return cursor.type === "rule" && cursor.name === "statement";
}

function isCaseArm(cursor: Cursor): boolean {
  return cursor.type === "rule" && cursor.name === "case_arm";
}

function isElseClause(cursor: Cursor): boolean {
  return cursor.type === "rule" &&
    (cursor.name === "conditional_statement_else_if_clause" ||
      cursor.name === "conditional_statement_else_clause");
}

function isOpenBracket(text: string): boolean {
  return text === "[" || text === "(";
}

function isCloseBracket(text: string): boolean {
  return text === "]" || text === ")";
}

function isBlankChar(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

function recursiveBindingKind(rule: Rule): "let" | "const" | null {
  const binding = directRule(rule, "binding");
  if (binding === null || directToken(binding, "rec") === null) return null;
  return declarationKind(binding);
}

function recursiveDeclarationKind(
  rule: Rule,
): "let" | "const" | null {
  const bindingKind = recursiveBindingKind(rule);
  if (bindingKind !== null) return bindingKind;
  const signature = directRule(rule, "signature");
  if (signature === null || directToken(signature, "rec") === null) {
    return null;
  }
  return declarationKind(signature);
}

function declarationKind(rule: Rule): "let" | "const" {
  if (directToken(rule, "let") !== null) return "let";
  if (directToken(rule, "const") !== null) return "const";
  throw new FormatterInvariantError(`${rule.name} has no declaration kind`);
}

interface PreservedBase {
  readonly width: number;
  readonly depth: number;
}

interface PreservedInfo {
  readonly base: PreservedBase;
  readonly node: Rule;
}
