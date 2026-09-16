// src/tooling/format/ir.ts
//
// Typed formatting IR: one indexed view over a single snapshot.
//
// Build runs one traversal and produces parent links, layout contexts,
// token/trivia ownership, and the compositional drop sets (redundant
// parentheses, discard-sequencing prefixes). Print consumes the IR without
// invoking the frontend. Layout contexts name the printing situation of
// each rule; unknown rule names map to transparent rather than failing,
// so grammar additions degrade to generic printing instead of a crash.

import type { Rule, TokenCursor } from "../../syntax/cursor.ts";
import type { TriviaAttachment } from "./trivia.ts";

/** First direct token child with the given text, if any. */
export function directToken(rule: Rule, text: string): TokenCursor | null {
  for (const child of rule.children()) {
    if (child.type === "token" && child.text === text) return child;
  }
  return null;
}

/** First direct rule child with the given name, if any. */
export function directRule(rule: Rule, name: string): Rule | null {
  const found = directRules(rule, name);
  if (found.length === 0) return null;
  const first = found[0];
  if (first === undefined) return null;
  return first;
}

/** Every direct rule child with the given name. */
export function directRules(rule: Rule, name: string): readonly Rule[] {
  return rule.children().filter((child): child is Rule =>
    child.type === "rule" && child.name === name
  );
}

/** Direct rule children of any name. */
export function childRules(rule: Rule): readonly Rule[] {
  return rule.children().filter((child): child is Rule =>
    child.type === "rule"
  );
}

/** Rules whose layout survives line joining decisions. */
export const LAYOUT_SENSITIVE_RULES: ReadonlySet<string> = new Set([
  "array",
  "block",
  "do_block",
  "case_expression",
  "effect_row",
  "shape",
]);

/** Statements whose suites force blank separation after them. */
export const SUITE_STATEMENT_RULES: ReadonlySet<string> = new Set([
  "conditional_statement",
  "iteration",
]);

/** Delimited rules that own vertical element layout. */
export const DELIMITED_RULES: ReadonlySet<string> = new Set([
  "array",
  "array_pattern",
  "effect_row",
  "parenthesized_or_tuple",
  "tuple_pattern",
  "shape",
  "shape_pattern",
]);

export type LayoutContext =
  | "declaration"
  | "signature"
  | "statement"
  | "suite"
  | "doBlock"
  | "delimited"
  | "pattern"
  | "lambda"
  | "application"
  | "infix"
  | "case"
  | "conditional"
  | "transparent";

const ruleContexts: Readonly<Record<string, LayoutContext>> = {
  program: "declaration",
  module_header: "declaration",
  fixity_declaration: "declaration",
  declaration: "declaration",
  statement: "statement",
  signature: "signature",
  binding: "declaration",
  indented_value: "transparent",
  declaration_tag: "declaration",
  rebinding: "statement",
  rebinding_suffix: "transparent",
  index_suffix: "delimited",
  sequencing: "statement",
  iteration: "statement",
  iteration_source: "transparent",
  breaking: "statement",
  continuing: "statement",
  opening: "statement",
  result: "statement",
  binding_pattern: "pattern",
  pattern_core: "pattern",
  unit_pattern: "pattern",
  tuple_pattern: "delimited",
  annotated_pattern: "pattern",
  array_pattern: "delimited",
  constructor_pattern: "pattern",
  shape_pattern: "delimited",
  shape_pattern_field: "pattern",
  expression: "infix",
  continued_expression: "infix",
  continued_operand: "infix",
  continued_postfix_expression: "application",
  continued_primary_expression: "application",
  infix_operation: "infix",
  bounded_lambda: "lambda",
  operand: "infix",
  prefix_operator: "infix",
  postfix_expression: "application",
  application_argument: "application",
  field_suffix: "application",
  field_name: "transparent",
  keyword: "transparent",
  primary_expression: "application",
  import_expression: "transparent",
  effect_row: "delimited",
  effect_row_part: "delimited",
  effect_row_tail: "transparent",
  application_primary: "application",
  constructor_expression: "transparent",
  unit: "delimited",
  parenthesized_or_tuple: "delimited",
  array: "delimited",
  array_element: "delimited",
  value: "transparent",
  shape: "delimited",
  shape_member: "delimited",
  shape_spread: "delimited",
  shape_field: "delimited",
  computed_shape_field: "delimited",
  lambda: "lambda",
  lambda_parameter: "lambda",
  lambda_result: "lambda",
  conditional_statement: "conditional",
  conditional_statement_guard: "conditional",
  conditional_statement_branches: "conditional",
  conditional_statement_else_if_clause: "conditional",
  conditional_statement_else_clause: "conditional",
  case_expression: "case",
  case_arm: "case",
  case_guard: "case",
  do_block: "doBlock",
  statement_suite: "suite",
  qualified_name: "transparent",
  qualified_name_part: "transparent",
  operator_token: "transparent",
};

/** Layout context for a rule name; unknown names are transparent. */
export function contextForRule(name: string): LayoutContext {
  const context = ruleContexts[name];
  if (context === undefined) return "transparent";
  return context;
}

/** A CST rule with its parent link and layout context. */
export interface IrNode {
  readonly rule: Rule;
  readonly parent: IrNode | null;
  readonly context: LayoutContext;
  readonly depth: number;
}

/** A leaf token in document order with its IR owner. */
export interface IrToken {
  readonly token: TokenCursor;
  readonly owner: IrNode;
  /** Index into the trivia tape mains, assigned by order alignment. */
  readonly mainIndex: number;
}

/** A source span whose tokens the printer omits. */
export interface DroppedSpan {
  readonly start: number;
  readonly end: number;
}

/** Eager statement layout decided before rendering. */
export type StatementLayout =
  | { readonly kind: "join" }
  | { readonly kind: "break" }
  | { readonly kind: "keep" };

/**
 * Compositional plan: poison-discard compatibility plus eager statement
 * layouts. `fallback` preserves every source break; otherwise statements
 * in `layouts` join or break while all other constructs follow group fit.
 */
export interface FormatPlan {
  readonly fallback: boolean;
  readonly layouts: ReadonlyMap<Rule, StatementLayout>;
  /** Signatures whose scope reindents without restructuring. */
  readonly scopeTouch: ReadonlySet<Rule>;
}

export interface FormatIr {
  readonly source: string;
  readonly lineStarts: readonly number[];
  readonly root: IrNode;
  readonly nodes: ReadonlyMap<Rule, IrNode>;
  readonly leaves: readonly IrToken[];
  readonly trivia: TriviaAttachment;
  readonly dropped: readonly DroppedSpan[];
  readonly plan: FormatPlan;
}
