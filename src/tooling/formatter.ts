import type { Diagnostic } from "../diagnostic.ts";
import { parseConcrete } from "../syntax/parse.ts";
import type { Module, Span } from "../syntax/ast.ts";

export type FormatResult =
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

type ConcreteNode =
  | {
    readonly type: "token";
    readonly kind: string;
    readonly text: string;
    readonly span: Span;
  }
  | {
    readonly type: "rule";
    readonly name: string;
    readonly span: Span;
    children(): readonly ConcreteNode[];
  };

interface IndentRegion {
  readonly startsAtLine: number;
  readonly endsAtLine: number;
  readonly includesLastLine: boolean;
}

const INDENTED_RULES = new Set([
  "array",
  "array_pattern",
  "block",
  "case_expression",
  "effect_row",
  "element_expression",
  "handler_composition",
  "operator_section",
  "shape",
  "shape_pattern",
  "statement_suite",
]);

/**
 * Applies Blot's deliberately small house style: two-space structural
 * indentation, no trailing whitespace, LF line endings, and one final newline.
 * Non-whitespace source content is retained, so comments never need a second
 * lexer and cannot be dropped by printing from the elaborated AST.
 */
export async function formatSource(source: string): Promise<FormatResult> {
  const parsed = await parseConcrete(source);
  if (!parsed.ok) return parsed;

  const lineStarts = sourceLineStarts(source);
  const regions: IndentRegion[] = [];
  collectIndentRegions(parsed.cst, lineStarts, regions);
  const redundantParentheses: Span[] = [];
  collectRedundantParentheses(parsed.cst, [], source, redundantParentheses);

  let withoutRedundantParentheses = removeParentheses(
    source,
    redundantParentheses,
  );
  if (redundantParentheses.length > 0) {
    const reparsed = await parseConcrete(withoutRedundantParentheses);
    if (
      !reparsed.ok ||
      moduleWithoutSpans(reparsed.module) !== moduleWithoutSpans(parsed.module)
    ) {
      withoutRedundantParentheses = source;
    }
  }
  const lines = withoutRedundantParentheses.split("\n");
  const formatted = lines.map((line, index) => {
    const content = line.trim();
    if (content === "") return "";
    const closesRegion = /^(else\b|[}\])]|<\/)/.test(content);
    const openingLines = new Set<number>();
    for (const region of regions) {
      if (index <= region.startsAtLine) continue;
      if (index < region.endsAtLine) openingLines.add(region.startsAtLine);
      if (
        index === region.endsAtLine && region.includesLastLine &&
        !closesRegion
      ) {
        openingLines.add(region.startsAtLine);
      }
    }
    return `${"  ".repeat(openingLines.size)}${content}`;
  });
  const formattedSource = `${formatted.join("\n").trimEnd()}\n`;
  const reparsed = await parseConcrete(formattedSource);
  if (
    reparsed.ok &&
    moduleWithoutSpans(reparsed.module) === moduleWithoutSpans(parsed.module)
  ) {
    return { ok: true, source: formattedSource };
  }

  const preservedLayout = `${
    lines.map((line) => line.trimEnd()).join("\n").trimEnd()
  }\n`;
  const preserved = await parseConcrete(preservedLayout);
  if (
    !preserved.ok ||
    moduleWithoutSpans(preserved.module) !== moduleWithoutSpans(parsed.module)
  ) {
    throw new Error("formatter could not preserve the parsed module");
  }
  return { ok: true, source: preservedLayout };
}

function collectRedundantParentheses(
  node: ConcreteNode,
  ancestors: readonly ConcreteRule[],
  source: string,
  parentheses: Span[],
): void {
  if (node.type !== "rule") return;
  if (
    node.name === "parenthesized_or_tuple" &&
    source.slice(node.span.start, node.span.end).indexOf("\n") < 0 &&
    parenthesesAreRedundant(node, ancestors)
  ) {
    parentheses.push(node.span);
  }
  const nestedAncestors = [...ancestors, node];
  for (const child of node.children()) {
    collectRedundantParentheses(child, nestedAncestors, source, parentheses);
  }
}

type ConcreteRule = Extract<ConcreteNode, { readonly type: "rule" }>;

function parenthesesAreRedundant(
  grouping: ConcreteRule,
  ancestors: readonly ConcreteRule[],
): boolean {
  if (
    grouping.children().some((child) =>
      child.type === "token" && child.text === ","
    )
  ) {
    return false;
  }
  const value = directRule(grouping, "value");
  if (value === null) return false;
  const expression = directRule(value, "expression");
  if (expression === null) return false;
  if (directRules(expression, "infix_operation").length > 0) return false;

  const operand = directRule(expression, "operand");
  if (operand === null) return false;
  if (directRules(operand, "prefix_operator").length > 0) return false;
  const postfix = directRule(operand, "postfix_expression");
  if (postfix === null || !hasApplicationPrimary(postfix)) return false;

  const innerApplications = directRules(postfix, "application_argument");
  if (innerApplications.length === 0) return true;

  const outerPostfixIndex = findLastRule(ancestors, "postfix_expression");
  if (outerPostfixIndex < 0) return true;
  if (
    ancestors.slice(outerPostfixIndex + 1).some((ancestor) =>
      ancestor.name === "application_argument"
    )
  ) return false;
  const outerPostfix = ancestors[outerPostfixIndex];
  return directRules(outerPostfix, "field_suffix").length === 0;
}

function hasApplicationPrimary(postfix: ConcreteRule): boolean {
  const primary = directRule(postfix, "primary_expression");
  if (primary === null) return false;
  const inner = primary.children()[0];
  if (inner === undefined) return false;
  if (inner.type === "token") {
    return inner.kind === "IDENT" || inner.kind === "TYPE_IDENT" ||
      inner.kind === "INTEGER" || inner.kind === "FLOAT" ||
      inner.kind === "TEXT" || inner.kind === "INTRINSIC";
  }
  return inner.name === "constructor_expression" || inner.name === "unit" ||
    inner.name === "array" || inner.name === "shape" ||
    inner.name === "parenthesized_or_tuple";
}

function directRule(
  rule: ConcreteRule,
  name: string,
): ConcreteRule | null {
  const found = directRules(rule, name);
  if (found.length === 0) return null;
  return found[0];
}

function directRules(
  rule: ConcreteRule,
  name: string,
): readonly ConcreteRule[] {
  return rule.children().filter((child): child is ConcreteRule =>
    child.type === "rule" && child.name === name
  );
}

function findLastRule(
  rules: readonly ConcreteRule[],
  name: string,
): number {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    if (rules[index].name === name) return index;
  }
  return -1;
}

function removeParentheses(
  source: string,
  parentheses: readonly Span[],
): string {
  const removed = new Set<number>();
  for (const span of parentheses) {
    if (source[span.start] !== "(" || source[span.end - 1] !== ")") {
      throw new Error(
        `parenthesized source ${span.start}..${span.end} lost its delimiters`,
      );
    }
    removed.add(span.start);
    removed.add(span.end - 1);
  }
  const characters: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (!removed.has(index)) characters.push(source[index]);
  }
  return characters.join("");
}

function moduleWithoutSpans(module: Module): string {
  return JSON.stringify(module, (key, value) => {
    if (key === "span") return undefined;
    if (typeof value === "bigint") return `${value}n`;
    if (key === "name" && typeof value === "string") {
      return value.replace(/\$[0-9]+/g, "$span");
    }
    return value;
  });
}

function collectIndentRegions(
  node: ConcreteNode,
  lineStarts: readonly number[],
  regions: IndentRegion[],
): void {
  if (node.type !== "rule") return;
  if (INDENTED_RULES.has(node.name)) {
    let startsAtLine = lineAtOffset(lineStarts, node.span.start);
    if (
      (node.name === "block" || node.name === "statement_suite") &&
      startsAtLine > 0
    ) {
      startsAtLine -= 1;
    }
    const endsAtLine = lineAtOffset(
      lineStarts,
      Math.max(node.span.start, node.span.end - 1),
    );
    if (startsAtLine < endsAtLine) {
      regions.push({
        startsAtLine,
        endsAtLine,
        includesLastLine: node.name === "block",
      });
    }
  }
  for (const child of node.children()) {
    collectIndentRegions(child, lineStarts, regions);
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
