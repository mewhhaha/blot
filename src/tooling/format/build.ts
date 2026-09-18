// src/tooling/format/build.ts
//
// One-traversal IR construction plus compositional decisions.
//
// Build walks the snapshot CST once (explicit stack, depth counted) and
// produces the parent index, layout contexts, leaf order, and trivia
// ownership. It then applies the compositional rules that replace trial
// parsing: redundant-parenthesis drops derived from the grammar and
// lowering contract, discard-sequencing drops with the legacy guards, and
// eager statement layouts with poison-discard triggers. Nothing here
// invokes the frontend.

import type { Token } from "../../../generated/wasm/mod.ts";
import type { Cursor, Rule, TokenCursor } from "../../syntax/cursor.ts";
import { lineAtOffset } from "../../text/document.ts";
import { FormatterInvariantError } from "./errors.ts";
import {
  childRules,
  contextForRule,
  DELIMITED_RULES,
  directRule,
  directRules,
  directToken,
  type DroppedSpan,
  type FormatIr,
  type FormatPlan,
  type IrNode,
  type IrToken,
  type StatementLayout,
} from "./ir.ts";
import type { PrintLimits } from "./options.ts";
import { attachTrivia, type TapeComment } from "./trivia.ts";

export interface BuildInput {
  readonly source: string;
  readonly lineStarts: readonly number[];
  readonly cst: Rule;
  readonly tokens: readonly Token[];
  readonly limits: PrintLimits;
}

/** Builds the IR and compositional plan from one snapshot. */
export function buildFormatIr(input: BuildInput): FormatIr {
  if (input.source.length > input.limits.maxInputBytes) {
    throw new FormatterInvariantError(
      `formatter input exceeds ${input.limits.maxInputBytes} bytes`,
    );
  }
  const indexed = indexRules(input.cst, input.limits);
  const trivia = attachTrivia(input.lineStarts, input.tokens);
  const leaves = alignLeaves(
    input.source,
    indexed.leafRules,
    indexed.leafTokens,
    trivia.mains.length,
    trivia.mains.map((main) => main.text),
  );
  const dropped = collectDrops(input.source, input.lineStarts, indexed);
  const plan = decidePlan(
    input.source,
    input.lineStarts,
    indexed.root,
    trivia.comments,
  );
  return {
    source: input.source,
    lineStarts: input.lineStarts,
    root: indexed.root,
    nodes: indexed.nodes,
    leaves,
    trivia,
    dropped,
    plan,
  };
}

interface Indexed {
  readonly root: IrNode;
  readonly nodes: Map<Rule, IrNode>;
  readonly leafRules: IrNode[];
  readonly leafTokens: TokenCursor[];
}

/** Iterative pre-order walk assigning parents, contexts, and depths. */
function indexRules(cst: Rule, limits: PrintLimits): Indexed {
  const nodes = new Map<Rule, IrNode>();
  const leafRules: IrNode[] = [];
  const leafTokens: TokenCursor[] = [];
  const root: IrNode = {
    rule: cst,
    parent: null,
    context: contextForRule(cst.name),
    depth: 0,
  };
  nodes.set(cst, root);
  type Event =
    | { readonly kind: "rule"; readonly node: IrNode }
    | {
      readonly kind: "token";
      readonly owner: IrNode;
      readonly token: TokenCursor;
    };
  const stack: Event[] = [{ kind: "rule", node: root }];
  let count = 1;
  while (stack.length > 0) {
    const event = stack.pop();
    if (event === undefined) break;
    if (event.kind === "token") {
      leafRules.push(event.owner);
      leafTokens.push(event.token);
      continue;
    }
    const current = event.node;
    const children = current.rule.children();
    const pending: Event[] = [];
    for (const child of children) {
      if (child === undefined) continue;
      count += 1;
      if (count > limits.maxNodes) {
        throw new FormatterInvariantError(
          `formatter input exceeds ${limits.maxNodes} syntax nodes`,
        );
      }
      if (child.type === "token") {
        if (isLayoutToken(child)) continue;
        if (child.span.end <= child.span.start) continue;
        assertNoReservedLayout(child.text);
        pending.push({ kind: "token", owner: current, token: child });
        continue;
      }
      const depth = current.depth + 1;
      if (depth > limits.maxDepth) {
        throw new FormatterInvariantError(
          `formatter input exceeds depth ${limits.maxDepth}`,
        );
      }
      const node: IrNode = {
        rule: child,
        parent: current,
        context: contextForRule(child.name),
        depth,
      };
      nodes.set(child, node);
      pending.push({ kind: "rule", node });
    }
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const queued = pending[index];
      if (queued !== undefined) stack.push(queued);
    }
  }
  return { root, nodes, leafRules, leafTokens };
}

/**
 * Layout sentinels inserted by layout elaboration carry LAYOUT_ kinds and
 * zero-width or private-use spans. The printer computes its own layout, so
 * these tokens are never emitted. Identity comes from the token kind, never
 * from source text scanning.
 */
function isLayoutToken(token: TokenCursor): boolean {
  return token.kind.startsWith("LAYOUT_");
}

/**
 * Reserved layout characters (U+E000-U+F8FF) cannot appear in accepted
 * source: the frontend rejects them before formatting runs. Any occurrence
 * in an emitted token is a frontend drift, reported as an invariant.
 */
function assertNoReservedLayout(text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xe000 && code <= 0xf8ff) {
      throw new FormatterInvariantError(
        "syntax tree carries a reserved layout character",
      );
    }
  }
}

/**
 * Aligns CST leaves with tape mains by order and text. Both derive from
 * the same source through the same lexer, so any divergence is a frontend
 * drift reported as an invariant failure.
 */
function alignLeaves(
  source: string,
  owners: readonly IrNode[],
  leaves: readonly TokenCursor[],
  mainCount: number,
  mainTexts: readonly string[],
): IrToken[] {
  if (leaves.length !== mainCount) {
    throw new FormatterInvariantError(
      `syntax tree holds ${leaves.length} tokens but the tape holds ${mainCount}`,
    );
  }
  const aligned: IrToken[] = [];
  for (let index = 0; index < leaves.length; index += 1) {
    const leaf = leaves[index];
    const owner = owners[index];
    const expected = mainTexts[index];
    if (leaf === undefined || owner === undefined || expected === undefined) {
      throw new FormatterInvariantError("token alignment ran short");
    }
    if (leaf.text !== expected) {
      throw new FormatterInvariantError(
        `token ${index} reads ${JSON.stringify(leaf.text)} in the tree but ${
          JSON.stringify(expected)
        } on the tape`,
      );
    }
    const sliced = source.slice(leaf.span.start, leaf.span.end);
    if (sliced !== leaf.text) {
      throw new FormatterInvariantError(`token ${index} span mismatches`);
    }
    aligned.push({ token: leaf, owner, mainIndex: index });
  }
  return aligned;
}

function collectDrops(
  source: string,
  lineStarts: readonly number[],
  indexed: Indexed,
): DroppedSpan[] {
  const dropped: DroppedSpan[] = [];
  const stack: IrNode[] = [indexed.root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current.rule.name === "parenthesized_or_tuple") {
      const grouping = redundantGrouping(
        current,
        indexed.nodes,
        source,
        lineStarts,
      );
      if (grouping !== null) {
        dropped.push(grouping.open, grouping.close);
      }
    }
    if (current.rule.name === "sequencing") {
      const discard = discardPrefix(current, source);
      if (discard !== null) dropped.push(discard);
    }
    const children = current.rule.children();
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child === undefined || child.type !== "rule") continue;
      const node = indexed.nodes.get(child);
      if (node !== undefined) stack.push(node);
    }
  }
  return dropped;
}

/**
 * Compositional redundant-parenthesis rule, derived from the grammar and
 * lowering contract instead of trial parsing.
 *
 * Lowering (lowerModule's parenthesized_or_tuple case) is transparent for
 * single groupings: it returns the inner value directly and only builds a
 * tuple when a tail comma is present. Removing a single grouping therefore
 * preserves the module exactly when the surrounding grammar reads the same
 * tree without it. The decision peels nested single groupings in both
 * directions first: down to the core expression (so `((apply 1))` reads as
 * one application, never as an atom), and up to the effective position (so
 * the inner grouping shares the outer one's argument slot). The policy on
 * core and position is then:
 *
 * - Tuples (a comma child) are never groupings.
 * - Atoms and literals drop everywhere, except under an application head
 *   with field suffixes, where the suffix would reattach to the last
 *   operand instead of the whole grouping.
 * - Applications drop in function position (application is
 *   left-associative, so `(apply 1) 2` reads the same bare) and as tuple
 *   or array elements, but keep in argument position (`apply (apply 1)`
 *   would reassociate bare) and under field suffixes.
 * - Lambdas extend right, so a grouping around a lambda keeps in function
 *   position (removal would reattach arguments), in argument position
 *   (application_primary admits no bare lambda), and in non-last element
 *   position (the body would swallow the following comma); it drops as a
 *   last element and as a plain statement value. LANGUAGE.md documents the
 *   tuple-argument removal.
 * - Infix inside the grouping rebinds without parens: the flat
 *   operand/operator chain has no precedence in the grammar (fold-fixity
 *   resolves it semantically), so any infix keeps its parens. No operator
 *   table is consulted; the rule is uniformly conservative.
 * - Prefix operators and unlisted primaries (case, do-block) keep their
 *   parens, as do groupings in unrecognized positions.
 *
 * Only single-line groupings qualify, except a lambda in last-element
 * position, whose delimiters drop even across lines: the lambda keeps its
 * own lines, so no layout joins.
 */
function redundantGrouping(
  node: IrNode,
  nodes: ReadonlyMap<Rule, IrNode>,
  source: string,
  lineStarts: readonly number[],
): { readonly open: DroppedSpan; readonly close: DroppedSpan } | null {
  const rule = node.rule;
  for (const child of rule.children()) {
    if (child.type === "token" && child.text === ",") return null;
  }
  const decision = parenDropDecision(node, nodes);
  if (decision === null) return null;
  const multiline = lineAtOffset(lineStarts, rule.span.start) !==
    lineAtOffset(lineStarts, Math.max(rule.span.start, rule.span.end - 1));
  if (multiline && !decision.multilineOk) return null;
  if (
    source[rule.span.start] !== "(" || source[rule.span.end - 1] !== ")"
  ) {
    throw new FormatterInvariantError(
      `grouping at ${rule.span.start} lost its delimiters`,
    );
  }
  return {
    open: { start: rule.span.start, end: rule.span.start + 1 },
    close: { start: rule.span.end - 1, end: rule.span.end },
  };
}

interface ParenDropDecision {
  readonly multilineOk: boolean;
}

function parenDropDecision(
  grouping: IrNode,
  nodes: ReadonlyMap<Rule, IrNode>,
): ParenDropDecision | null {
  const value = directRule(grouping.rule, "value");
  if (value === null) return null;
  const core = groupingCore(value);
  const position = groupingPosition(grouping, nodes);
  if (core.kind === "lambda") {
    return decideLambdaGrouping(position);
  }
  if (core.kind === "application") {
    if (position.kind === "function" && !position.hasSuffix) {
      return { multilineOk: false };
    }
    if (position.kind === "element" || position.kind === "value") {
      return { multilineOk: false };
    }
    if (position.kind === "other") {
      return { multilineOk: false };
    }
    return null;
  }
  if (core.kind === "atom") {
    if (position.kind === "function" && position.hasSuffix) return null;
    if (position.kind === "argument" && position.hasSuffix) return null;
    if (position.kind === "unknown") return null;
    return { multilineOk: false };
  }
  return null;
}

function decideLambdaGrouping(
  position: GroupingPosition,
): ParenDropDecision | null {
  if (position.kind === "element") {
    if (position.last) return { multilineOk: true };
    return null;
  }
  if (position.kind === "value") return { multilineOk: false };
  return null;
}

type GroupingCore =
  | { readonly kind: "lambda" }
  | { readonly kind: "application" }
  | { readonly kind: "atom" }
  | { readonly kind: "opaque" };

/**
 * The core expression inside a grouping, peeling nested single groupings:
 * `((apply 1))` cores to one application, `((1))` to one atom. Infix,
 * prefixes, and unlisted primaries core to opaque and keep their parens.
 */
function groupingCore(value: Rule): GroupingCore {
  const core = peelGroupingInners(value);
  if (directRule(core, "lambda") !== null) return { kind: "lambda" };
  const expression = directRule(core, "expression");
  if (expression === null) return { kind: "opaque" };
  if (directRules(expression, "infix_operation").length > 0) {
    return { kind: "opaque" };
  }
  const operand = directPostfixOperand(expression);
  if (operand === null) return { kind: "opaque" };
  if (directRules(operand, "prefix_operator").length > 0) {
    return { kind: "opaque" };
  }
  const postfix = directPostfixOf(operand);
  if (postfix === null || !hasTransparentPrimary(postfix)) {
    return { kind: "opaque" };
  }
  if (directRules(postfix, "application_argument").length > 0) {
    return { kind: "application" };
  }
  return { kind: "atom" };
}

function peelGroupingInners(value: Rule): Rule {
  let current = value;
  while (true) {
    const inner = loneGroupingInner(current);
    if (inner === null) return current;
    current = inner;
  }
}

function loneGroupingInner(value: Rule): Rule | null {
  const expression = directRule(value, "expression");
  if (expression === null) return null;
  if (directRules(expression, "infix_operation").length > 0) return null;
  const operand = directPostfixOperand(expression);
  if (operand === null) return null;
  if (directRules(operand, "prefix_operator").length > 0) return null;
  const postfix = directPostfixOf(operand);
  if (postfix === null) return null;
  if (directRules(postfix, "application_argument").length > 0) return null;
  if (directRules(postfix, "field_suffix").length > 0) return null;
  const primary = directPrimaryOf(postfix);
  if (primary === null) return null;
  const inner = primary.children()[0];
  if (inner === undefined || inner.type !== "rule") return null;
  if (inner.name !== "parenthesized_or_tuple") return null;
  for (const child of inner.children()) {
    if (child.type === "token" && child.text === ",") return null;
  }
  return directRule(inner, "value");
}

type GroupingPosition =
  | { readonly kind: "argument"; readonly hasSuffix: boolean }
  | { readonly kind: "function"; readonly hasSuffix: boolean }
  | { readonly kind: "element"; readonly last: boolean }
  | { readonly kind: "value" }
  | { readonly kind: "other" }
  | { readonly kind: "unknown" };

/**
 * The effective position of a grouping, peeling transparent single
 * groupings upward first: the inner grouping of `apply ((apply 1))`
 * shares the outer one's argument slot, so both keep their parens.
 */
function groupingPosition(
  grouping: IrNode,
  nodes: ReadonlyMap<Rule, IrNode>,
): GroupingPosition {
  let effective = grouping.rule;
  while (true) {
    const node = nodes.get(effective);
    if (node === undefined || node.parent === null) break;
    const enclosing = enclosingGrouping(node.parent);
    if (enclosing === null) break;
    effective = enclosing;
  }
  return classifyGrouping(effective, nodes);
}

function enclosingGrouping(node: IrNode): Rule | null {
  if (!isPrimaryName(node.rule.name)) return null;
  const postfix = node.parent;
  if (postfix === null || !isPostfixName(postfix.rule.name)) return null;
  if (directRules(postfix.rule, "application_argument").length > 0) {
    return null;
  }
  if (directRules(postfix.rule, "field_suffix").length > 0) return null;
  const operand = postfix.parent;
  if (operand === null || !isOperandName(operand.rule.name)) return null;
  if (directRules(operand.rule, "prefix_operator").length > 0) return null;
  const expression = operand.parent;
  if (expression === null || !isExpressionName(expression.rule.name)) {
    return null;
  }
  if (directRules(expression.rule, "infix_operation").length > 0) return null;
  const value = expression.parent;
  if (value === null || value.rule.name !== "value") return null;
  const grouping = value.parent;
  if (grouping === null) return null;
  if (grouping.rule.name !== "parenthesized_or_tuple") return null;
  for (const child of grouping.rule.children()) {
    if (child.type === "token" && child.text === ",") return null;
  }
  return grouping.rule;
}

function classifyGrouping(
  effective: Rule,
  nodes: ReadonlyMap<Rule, IrNode>,
): GroupingPosition {
  const node = nodes.get(effective);
  if (node === undefined || node.parent === null) {
    return { kind: "unknown" };
  }
  const parent = node.parent;
  if (parent.rule.name === "application_primary") {
    return argumentPosition(parent);
  }
  if (!isPrimaryName(parent.rule.name)) return { kind: "unknown" };
  const postfix = parent.parent;
  if (postfix === null || !isPostfixName(postfix.rule.name)) {
    return { kind: "unknown" };
  }
  if (
    directRules(postfix.rule, "application_argument").length > 0 ||
    directRules(postfix.rule, "field_suffix").length > 0
  ) {
    return {
      kind: "function",
      hasSuffix: directRules(postfix.rule, "field_suffix").length > 0,
    };
  }
  return climbGroupingContext(postfix.parent);
}

function argumentPosition(primary: IrNode): GroupingPosition {
  const argument = primary.parent;
  if (argument === null || argument.rule.name !== "application_argument") {
    return { kind: "unknown" };
  }
  const postfix = argument.parent;
  if (postfix === null || !isPostfixName(postfix.rule.name)) {
    return { kind: "unknown" };
  }
  return {
    kind: "argument",
    hasSuffix: directRules(postfix.rule, "field_suffix").length > 0,
  };
}

/**
 * Climbs a bare application head (no arguments, no suffixes) to its
 * context: an element of a tuple or array, a plain statement value, an
 * infix or case scrutinee, or something unrecognized.
 */
function climbGroupingContext(node: IrNode | null): GroupingPosition {
  let current = node;
  while (current !== null) {
    const name = current.rule.name;
    if (isOperandName(name) || isExpressionName(name)) {
      if (directRules(current.rule, "infix_operation").length > 0) {
        return { kind: "other" };
      }
      current = current.parent;
      continue;
    }
    if (name === "value") {
      return classifyValueContext(current);
    }
    if (name === "array_element") {
      const group = current.parent;
      if (group === null) return { kind: "unknown" };
      return elementPosition(group.rule, current.rule);
    }
    if (name === "application_argument") {
      return argumentPositionFrom(current);
    }
    if (
      name === "infix_operation" || name === "case_expression" ||
      name === "operator_token"
    ) {
      return { kind: "other" };
    }
    return { kind: "unknown" };
  }
  return { kind: "unknown" };
}

function classifyValueContext(value: IrNode): GroupingPosition {
  const parent = value.parent;
  if (parent === null) return { kind: "unknown" };
  const name = parent.rule.name;
  if (name === "array_element") {
    const group = parent.parent;
    if (group === null) return { kind: "unknown" };
    return elementPosition(group.rule, parent.rule);
  }
  if (name === "parenthesized_or_tuple" || name === "tuple_pattern") {
    if (!hasCommaChild(parent.rule)) return { kind: "unknown" };
    return elementPosition(parent.rule, value.rule);
  }
  if (
    name === "binding" || name === "signature" || name === "result" ||
    name === "sequencing" || name === "rebinding" || name === "breaking" ||
    name === "continuing" || name === "case_arm" || name === "shape_field" ||
    name === "computed_shape_field" || name === "shape_member" ||
    name === "shape_spread"
  ) {
    return { kind: "value" };
  }
  return { kind: "unknown" };
}

function argumentPositionFrom(argument: IrNode): GroupingPosition {
  const postfix = argument.parent;
  if (postfix === null || !isPostfixName(postfix.rule.name)) {
    return { kind: "unknown" };
  }
  return {
    kind: "argument",
    hasSuffix: directRules(postfix.rule, "field_suffix").length > 0,
  };
}

/** Whether an element is the last of its delimited group (no comma after). */
function elementPosition(group: Rule, element: Rule): GroupingPosition {
  if (
    group.name !== "array" && group.name !== "array_pattern" &&
    group.name !== "parenthesized_or_tuple" && group.name !== "tuple_pattern"
  ) {
    return { kind: "unknown" };
  }
  return { kind: "element", last: isLastElement(group, element) };
}

function isLastElement(group: Rule, element: Rule): boolean {
  let seen = false;
  for (const child of group.children()) {
    if (!seen) {
      if (child.type === "rule" && child === element) seen = true;
      continue;
    }
    if (child.type === "token" && child.text === ",") return false;
  }
  return true;
}

function hasCommaChild(rule: Rule): boolean {
  for (const child of rule.children()) {
    if (child.type === "token" && child.text === ",") return true;
  }
  return false;
}

/** Postfix shape shared by plain and continued operands. */
function directPostfixOperand(expression: Rule): Rule | null {
  const operand = directRule(expression, "operand");
  if (operand !== null) return operand;
  return directRule(expression, "continued_operand");
}

function directPostfixOf(operand: Rule): Rule | null {
  const postfix = directRule(operand, "postfix_expression");
  if (postfix !== null) return postfix;
  return directRule(operand, "continued_postfix_expression");
}

function directPrimaryOf(postfix: Rule): Rule | null {
  const primary = directRule(postfix, "primary_expression");
  if (primary !== null) return primary;
  return directRule(postfix, "continued_primary_expression");
}

function isPrimaryName(name: string): boolean {
  return name === "primary_expression" ||
    name === "continued_primary_expression";
}

function isPostfixName(name: string): boolean {
  return name === "postfix_expression" ||
    name === "continued_postfix_expression";
}

function isOperandName(name: string): boolean {
  return name === "operand" || name === "continued_operand";
}

function isExpressionName(name: string): boolean {
  return name === "expression" || name === "continued_expression";
}

/**
 * Primary positions that survive grouping removal, read from the grammar:
 * primaries whose lowering is a single transparent value. Case, do-block,
 * and lambda bodies are excluded structurally: they never appear here.
 */
function hasTransparentPrimary(postfix: Rule): boolean {
  const primary = directPrimaryOf(postfix);
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

/**
 * Discard-sequencing normalization: `use _ <- expression` becomes
 * `use expression`, exactly as LANGUAGE.md documents them equivalent. The
 * guards are the legacy ones: a `use` head spelling exactly `_`, an arrow
 * after it in order, and blank-only gaps, so comments or layout between
 * the tokens keep the explicit spelling.
 */
function discardPrefix(node: IrNode, source: string): DroppedSpan | null {
  const rule = node.rule;
  const head = directRules(rule, "value")[0];
  const arrow = directToken(rule, "<-");
  const use = directToken(rule, "use");
  if (head === undefined || head === null) return null;
  if (arrow === null || use === null) return null;
  if (source.slice(head.span.start, head.span.end).trim() !== "_") return null;
  if (use.span.end > head.span.start) return null;
  if (head.span.end > arrow.span.start) return null;
  if (!isBlankGap(source.slice(use.span.end, head.span.start))) return null;
  if (!isBlankGap(source.slice(head.span.end, arrow.span.start))) return null;
  return { start: use.span.end, end: arrow.span.end };
}

function isBlankGap(gap: string): boolean {
  for (let index = 0; index < gap.length; index += 1) {
    const char = gap[index];
    if (char !== " " && char !== "\t") return false;
  }
  return true;
}

// Rule sets for layout analysis, read from the grammar contract.
// Value-scope boundaries exempt delimited checks because the scope owns
// the layout, not the declaration.
const VALUE_SCOPE_BOUNDARY_RULES = new Set([
  "block",
  "do_block",
  "case_expression",
]);

const INDENTED_VALUE_RULES = new Set([
  "continued_expression",
  "lambda",
]);

const INDENTED_RULES = new Set([
  "array",
  "array_pattern",
  "block",
  "case_expression",
  "continued_expression",
  "effect_row",
  "lambda",
  "parenthesized_or_tuple",
  "tuple_pattern",
  "shape",
  "shape_pattern",
  "statement_suite",
]);

const MAXIMUM_LINE_WIDTH = 80;

/**
 * Eager statement plan plus the poison-discard trigger.
 *
 * Signatures, bindings, and results join or break by the documented width
 * rules, decided once from the source snapshot: overlong first lines move
 * the value as a whole to the next level, multiline delimited values under
 * signatures and bindings move as a whole, and bindings never rejoin (the
 * formatted output keeps a broken binding broken). Annotated bindings keep
 * their line structure: the historical statement pass misread the
 * annotation as the value and its only observable outcome was poisoned
 * output that the pipeline discarded, so keeping them is behavior-preserving.
 *
 * Trigger S fires when an annotated binding would take that historical
 * path (the misread width exceeds the limit). The pipeline then preserves
 * every source break, matching the discarded fixed point without parsing.
 */
function decidePlan(
  source: string,
  lineStarts: readonly number[],
  root: IrNode,
  comments: readonly TapeComment[],
): FormatPlan {
  const statements: Rule[] = [];
  collectStatements(root.rule, statements);
  statements.sort((left, right) => left.span.start - right.span.start);
  const layouts = new Map<Rule, StatementLayout>();
  const scopeTouch = new Set<Rule>();
  let fallback = false;
  for (const statement of statements) {
    if (statement.name === "binding" && directToken(statement, ":") !== null) {
      if (annotatedBindingPoisons(statement, source)) fallback = true;
      continue;
    }
    const layout = statementLayout(statement, source, comments);
    if (layout.kind === "join" || layout.kind === "break") {
      layouts.set(statement, layout);
      continue;
    }
    if (
      statement.name === "signature" &&
      signatureScopeNeedsTouch(statement, source, lineStarts)
    ) {
      scopeTouch.add(statement);
    }
  }
  return { fallback, layouts, scopeTouch };
}

function collectStatements(rule: Rule, statements: Rule[]): void {
  const stack: Rule[] = [rule];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (
      current.name === "signature" || current.name === "binding" ||
      current.name === "result"
    ) {
      statements.push(current);
    }
    const children = childRules(current);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }
}

/**
 * Historical misread width for annotated bindings: the annotation served as
 * the value while the introducer sat after the `=`, so the measured width
 * spans the annotation twice. Exceeding the limit poisoned the fixed point;
 * the trigger preserves that outcome compositionally.
 */
function annotatedBindingPoisons(statement: Rule, source: string): boolean {
  const introducer = directToken(statement, "=");
  const annotation = directRule(statement, "value");
  if (introducer === null || annotation === null) return false;
  const lineStart = source.lastIndexOf("\n", introducer.span.start - 1) + 1;
  const annotationText = source.slice(
    annotation.span.start,
    contentEndOf(annotation),
  );
  const firstBreak = annotationText.indexOf("\n");
  let firstLine = annotationText;
  if (firstBreak >= 0) firstLine = annotationText.slice(0, firstBreak);
  const width = introducer.span.end - lineStart + 1 + firstLine.length;
  if (width > MAXIMUM_LINE_WIDTH) return true;
  if (!annotationText.includes("\n")) return false;
  return annotationUsesDelimiters(annotation);
}

function annotationUsesDelimiters(annotation: Rule): boolean {
  if (
    annotation.name === "lambda" || directRule(annotation, "lambda") !== null
  ) {
    return false;
  }
  let expression = directRule(annotation, "expression");
  if (annotation.name === "continued_expression") expression = annotation;
  if (expression === null) return false;
  if (valueScopeOwnsLayout(expression)) return false;
  return containsRule(expression, DELIMITED_RULES);
}

function statementLayout(
  statement: Rule,
  source: string,
  comments: readonly TapeComment[],
): StatementLayout {
  let introducer = directToken(statement, "return");
  if (statement.name === "signature") introducer = directToken(statement, ":");
  if (statement.name === "binding") introducer = directToken(statement, "=");
  if (introducer === null) return { kind: "keep" };
  let value = directRule(statement, "value");
  const indented = directRule(statement, "indented_value");
  if (indented !== null) value = indentedBindingValue(indented);
  if (value === null) return { kind: "keep" };
  const valueStart = value.span.start;
  const valueEnd = contentEndOf(value);
  const separator = source.slice(introducer.span.end, valueStart);
  if (!isBlankSeparator(separator)) return { kind: "keep" };
  const valueSource = source.slice(valueStart, valueEnd);
  const lineStart = source.lastIndexOf("\n", introducer.span.start - 1) + 1;
  const indent = leadingBlankWidth(source, lineStart);
  const joined = !separator.includes("\n");
  const multiline = valueSource.includes("\n");
  const firstBreak = valueSource.indexOf("\n");
  let firstLine = valueSource;
  if (firstBreak >= 0) firstLine = valueSource.slice(0, firstBreak);
  // The joined first line carries its trailing comment, exactly as the
  // delimited width rules measure their trailing suffix: without it the
  // statement keeps a line the value rules then break, and the next pass
  // breaks the statement, oscillating forever. Comments come from the
  // trivia tape by span, never from scanning source text.
  const trailing = trailingCommentWidth(
    source,
    valueStart + firstLine.length,
    comments,
  );
  const inlineWidth = introducer.span.end - lineStart + 1 + firstLine.length +
    trailing;
  const ownsDelimitedValue =
    (statement.name === "binding" || statement.name === "signature") &&
    multiline && valueUsesDelimiters(value);
  const needsBreak = inlineWidth > MAXIMUM_LINE_WIDTH || ownsDelimitedValue;
  if (!needsBreak) {
    if (joined && separator === " ") return { kind: "keep" };
    if (statement.name === "binding") return { kind: "keep" };
    return { kind: "join" };
  }
  if (!joined && separator === `\n${" ".repeat(indent)}  `) {
    return { kind: "keep" };
  }
  return { kind: "break" };
}

/**
 * Rendered width of comments trailing the value's first line: one
 * normalized space plus the comment text each. Only comments on the same
 * source line, with no newline between the first-line end and the comment,
 * count; comments trailing later value lines belong to those lines.
 */
function trailingCommentWidth(
  source: string,
  firstLineEnd: number,
  comments: readonly TapeComment[],
): number {
  let width = 0;
  for (const comment of comments) {
    if (comment.span.start < firstLineEnd) continue;
    const between = source.slice(firstLineEnd, comment.span.start);
    if (between.includes("\n")) continue;
    width += 1 + (comment.span.end - comment.span.start);
  }
  return width;
}

/**
 * Signature scopes reindent without restructuring: a multiline signature
 * value already on its own lines keeps its breaks while its lines take
 * structural indentation. Fires exactly when a scope line differs, matching
 * the historical normalization it replaces.
 */
function signatureScopeNeedsTouch(
  statement: Rule,
  source: string,
  lineStarts: readonly number[],
): boolean {
  let value = directRule(statement, "value");
  const indented = directRule(statement, "indented_value");
  if (indented !== null) value = indentedBindingValue(indented);
  if (value === null) return false;
  const introducer = directToken(statement, ":");
  if (introducer === null) return false;
  const separator = source.slice(introducer.span.end, value.span.start);
  if (!isBlankSeparator(separator)) return false;
  if (separator.includes("\n") === false) return false;
  const valueSource = source.slice(value.span.start, contentEndOf(value));
  if (!valueSource.includes("\n")) return false;
  const levels = computeStructuralLevels(
    source,
    lineStarts,
    statement,
    mainsByLine(lineStarts, statement),
  );
  const startsAtLine = lineAtOffset(lineStarts, statement.span.start);
  const endsAtLine = lineAtOffset(
    lineStarts,
    Math.max(statement.span.start, contentEndOf(statement) - 1),
  );
  for (let line = startsAtLine; line <= endsAtLine; line += 1) {
    const level = levels[line - startsAtLine];
    if (level === undefined) continue;
    const start = lineStarts[line];
    if (start === undefined) continue;
    let end = source.indexOf("\n", start);
    if (end < 0) end = source.length;
    const content = source.slice(start, end);
    if (isBlankLine(content)) continue;
    if (leadingBlankWidth(source, start) !== level * 2) return true;
  }
  return false;
}

function indentedBindingValue(indented: Rule): Rule | null {
  for (const child of childRules(indented)) {
    if (INDENTED_VALUE_RULES.has(child.name)) return child;
  }
  return null;
}

function valueUsesDelimiters(value: Rule): boolean {
  if (value.name === "lambda" || directRule(value, "lambda") !== null) {
    return false;
  }
  let expression = directRule(value, "expression");
  if (value.name === "continued_expression") expression = value;
  if (expression === null) return false;
  if (valueScopeOwnsLayout(expression)) return false;
  return containsRule(expression, DELIMITED_RULES);
}

function valueScopeOwnsLayout(expression: Rule): boolean {
  if (expressionPrimaryIs(expression, "do_block")) return true;
  for (const name of VALUE_SCOPE_BOUNDARY_RULES) {
    if (expressionPrimaryIs(expression, name)) return true;
  }
  return false;
}

function expressionPrimaryIs(expression: Rule, name: string): boolean {
  const operand = directRule(expression, "operand");
  if (operand === null) return false;
  const postfix = directRule(operand, "postfix_expression");
  if (postfix === null) return false;
  const primary = directRule(postfix, "primary_expression");
  if (primary === null) return false;
  return directRule(primary, name) !== null;
}

function containsRule(node: Rule, names: ReadonlySet<string>): boolean {
  const stack: Rule[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (names.has(current.name)) return true;
    const children = childRules(current);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return false;
}

function isBlankSeparator(separator: string): boolean {
  for (let index = 0; index < separator.length; index += 1) {
    const char = separator[index];
    if (
      char !== " " && char !== "\t" && char !== "\r" && char !== "\n"
    ) {
      return false;
    }
  }
  return true;
}

function isBlankLine(content: string): boolean {
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char !== " " && char !== "\t" && char !== "\r") return false;
  }
  return true;
}

function leadingBlankWidth(source: string, lineStart: number): number {
  let width = 0;
  while (
    source[lineStart + width] === " " || source[lineStart + width] === "\t"
  ) {
    width += 1;
  }
  return width;
}

/** Last content offset, skipping layout sentinels and zero-width tokens. */
function contentEndOf(rule: Rule): number {
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

/** Lines carrying main-channel tokens, for code-line search. */
function mainsByLine(
  lineStarts: readonly number[],
  root: Rule,
): ReadonlySet<number> {
  const lines = new Set<number>();
  const stack: Cursor[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current.type === "token") {
      if (current.kind.startsWith("LAYOUT_")) continue;
      if (current.span.end <= current.span.start) continue;
      lines.add(lineAtOffset(lineStarts, current.span.start));
      continue;
    }
    const children = current.children();
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return lines;
}

interface IndentRegion {
  readonly startsAtLine: number;
  readonly endsAtLine: number;
  readonly includesLastLine: boolean;
}

/**
 * Structural indentation levels per source line, relative to the given
 * root's first line. Regions follow the historical computation exactly
 * (binding, signature, result, do-block, lambda, and indented-rule spans
 * with the suite offset and the delimited closing rule), but the per-line
 * accumulation is a single sweep over merged same-start intervals instead
 * of a scan per line. Comment awareness comes from the token tape (code
 * lines carry main tokens), never from source text matching.
 */
export function computeStructuralLevels(
  source: string,
  lineStarts: readonly number[],
  root: Rule,
  codeLines: ReadonlySet<number>,
): readonly number[] {
  const regions: IndentRegion[] = [];
  collectIndentRegions(source, lineStarts, root, codeLines, regions);
  const startsAtLine = lineAtOffset(lineStarts, root.span.start);
  const endsAtLine = lineAtOffset(
    lineStarts,
    Math.max(root.span.start, contentEndOf(root) - 1),
  );
  const lineCount = endsAtLine - startsAtLine + 1;
  const byStart = new Map<number, Array<{ end: number; last: boolean }>>();
  for (const region of regions) {
    if (region.endsAtLine < startsAtLine) continue;
    if (region.startsAtLine > endsAtLine) continue;
    let group = byStart.get(region.startsAtLine);
    if (group === undefined) {
      group = [];
      byStart.set(region.startsAtLine, group);
    }
    group.push({ end: region.endsAtLine, last: region.includesLastLine });
  }
  const events = new Map<number, number>();
  const addEvent = (line: number, delta: number): void => {
    const previous = events.get(line);
    if (previous === undefined) events.set(line, delta);
    else events.set(line, previous + delta);
  };
  for (const [start, group] of byStart) {
    let maxEnd = start;
    let includesMaxEnd = false;
    for (const member of group) {
      if (member.end > maxEnd) {
        maxEnd = member.end;
        includesMaxEnd = member.last;
      } else if (member.end === maxEnd && member.last) {
        includesMaxEnd = true;
      }
    }
    addEvent(start + 1, 1);
    addEvent(maxEnd, -1);
    if (includesMaxEnd) {
      addEvent(maxEnd, 1);
      addEvent(maxEnd + 1, -1);
    }
  }
  const levels: number[] = [];
  let level = 0;
  for (let line = startsAtLine; line <= endsAtLine; line += 1) {
    const delta = events.get(line);
    if (delta !== undefined) level += delta;
    levels.push(level);
  }
  if (levels.length !== lineCount) {
    throw new FormatterInvariantError("structural sweep ran short");
  }
  return levels;
}

function collectIndentRegions(
  source: string,
  lineStarts: readonly number[],
  root: Rule,
  codeLines: ReadonlySet<number>,
  regions: IndentRegion[],
): void {
  const previousCodeLine: number[] = [];
  let previous = 0;
  for (let line = 0; line < lineStarts.length; line += 1) {
    if (codeLines.has(line)) previous = line;
    previousCodeLine.push(previous);
  }
  const stack: Rule[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.name === "binding" || node.name === "signature") {
      bindingRegion(node, lineStarts, regions);
    }
    if (node.name === "result") {
      resultRegion(node, lineStarts, regions);
    }
    if (node.name === "do_block") {
      doRegion(node, lineStarts, regions);
    }
    indentedRuleRegion(
      node,
      source,
      lineStarts,
      previousCodeLine,
      regions,
    );
    const children = childRules(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }
}

function bindingRegion(
  node: Rule,
  lineStarts: readonly number[],
  regions: IndentRegion[],
): void {
  const indented = directRule(node, "indented_value");
  let value = directRule(node, "value");
  if (indented !== null) value = indentedBindingValue(indented);
  if (value === null) return;
  let introducer = directToken(node, "=");
  if (node.name === "signature") introducer = directToken(node, ":");
  if (introducer === null) {
    throw new FormatterInvariantError(`${node.name} has no introducer`);
  }
  const startsAtLine = lineAtOffset(lineStarts, introducer.span.start);
  const valueStartsAtLine = lineAtOffset(lineStarts, value.span.start);
  const endsAtLine = lineAtOffset(
    lineStarts,
    Math.max(value.span.start, contentEndOf(value) - 1),
  );
  if (startsAtLine < valueStartsAtLine && startsAtLine < endsAtLine) {
    regions.push({ startsAtLine, endsAtLine, includesLastLine: true });
  }
}

function resultRegion(
  node: Rule,
  lineStarts: readonly number[],
  regions: IndentRegion[],
): void {
  const value = directRule(node, "value");
  if (value === null) return;
  const startsAtLine = lineAtOffset(lineStarts, node.span.start);
  const endsAtLine = lineAtOffset(
    lineStarts,
    Math.max(value.span.start, contentEndOf(value) - 1),
  );
  if (
    startsAtLine < endsAtLine &&
    !hasInlineLayoutRegion(value, startsAtLine, lineStarts)
  ) {
    regions.push({ startsAtLine, endsAtLine, includesLastLine: true });
  }
}

function doRegion(
  node: Rule,
  lineStarts: readonly number[],
  regions: IndentRegion[],
): void {
  const startsAtLine = lineAtOffset(lineStarts, node.span.start);
  const endsAtLine = lineAtOffset(
    lineStarts,
    Math.max(node.span.start, contentEndOf(node) - 1),
  );
  if (startsAtLine < endsAtLine) {
    regions.push({ startsAtLine, endsAtLine, includesLastLine: true });
  }
}

function indentedRuleRegion(
  node: Rule,
  source: string,
  lineStarts: readonly number[],
  previousCodeLine: readonly number[],
  regions: IndentRegion[],
): void {
  let indents = INDENTED_RULES.has(node.name);
  if (node.name === "lambda") {
    const body = directRule(node, "expression");
    if (body === null) {
      throw new FormatterInvariantError("lambda has no body");
    }
    const parameters = directRules(node, "lambda_parameter");
    const lastParameter = parameters[parameters.length - 1];
    if (lastParameter === undefined) {
      throw new FormatterInvariantError("lambda has no parameter");
    }
    const arrow = directToken(lastParameter, "=>");
    if (arrow === null) {
      throw new FormatterInvariantError("lambda parameter has no boundary");
    }
    indents = lineAtOffset(lineStarts, arrow.span.start) <
      lineAtOffset(lineStarts, body.span.start);
  }
  if (!indents) return;
  let startsAtLine = lineAtOffset(lineStarts, node.span.start);
  if (
    (node.name === "block" || node.name === "statement_suite") &&
    startsAtLine > 0
  ) {
    startsAtLine -= 1;
  }
  const contentEnd = contentEndOf(node);
  const contentLine = lineAtOffset(
    lineStarts,
    Math.max(node.span.start, contentEnd - 1),
  );
  const limit = lineAtOffset(lineStarts, node.span.start);
  let endsAtLine = contentLine;
  const previous = previousCodeLine[contentLine];
  if (previous !== undefined && previous >= limit && previous < endsAtLine) {
    endsAtLine = previous;
  }
  if (endsAtLine < limit) endsAtLine = limit;
  if (startsAtLine >= endsAtLine) return;
  let includesLastLine = node.name === "block" || node.name === "lambda" ||
    node.name === "case_expression" || node.name === "statement_suite";
  if (DELIMITED_RULES.has(node.name)) {
    includesLastLine = !delimitedClosesOnLastLine(
      node,
      source,
      lineStarts,
      endsAtLine,
    );
  }
  regions.push({ startsAtLine, endsAtLine, includesLastLine });
}

/**
 * Whether a delimited rule's closing line starts with a closing delimiter.
 * The first main token on the line decides: comments cannot precede code
 * on a line, so the token's first character equals the trimmed line's.
 */
function delimitedClosesOnLastLine(
  node: Rule,
  source: string,
  lineStarts: readonly number[],
  endsAtLine: number,
): boolean {
  void source;
  const closing = firstMainTokenOnLine(node, lineStarts, endsAtLine);
  if (closing === null) return false;
  const first = closing.text[0];
  return first === ")" || first === "]" || first === "}";
}

function firstMainTokenOnLine(
  node: Rule,
  lineStarts: readonly number[],
  line: number,
): TokenCursor | null {
  let found: TokenCursor | null = null;
  const stack: Cursor[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current.type === "token") {
      if (current.kind.startsWith("LAYOUT_")) continue;
      if (current.span.end <= current.span.start) continue;
      if (lineAtOffset(lineStarts, current.span.start) !== line) continue;
      if (found === null || current.span.start < found.span.start) {
        found = current;
      }
      continue;
    }
    const children = current.children();
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return found;
}

function hasInlineLayoutRegion(
  node: Rule,
  line: number,
  lineStarts: readonly number[],
): boolean {
  const stack: Rule[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (
      (INDENTED_RULES.has(current.name) || current.name === "do_block") &&
      lineAtOffset(lineStarts, current.span.start) === line
    ) {
      return true;
    }
    const children = childRules(current);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push(child);
    }
  }
  return false;
}
