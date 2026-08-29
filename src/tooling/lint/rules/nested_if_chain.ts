import type { Branch, Expr, Span } from "../../../syntax/ast.ts";
import type { Rule } from "../../../syntax/cursor.ts";
import {
  directRule,
  fieldRule,
  fieldRules,
  producedExpression,
  spanKey,
} from "../syntax.ts";
import type { AstNode, LintRule, LintRuleContext } from "../types.ts";
import { prefersEqualityCase } from "./equality_if_chain.ts";

export const nestedIfChain: LintRule = {
  name: "nested-if-chain",
  code: "BLOT_LINT_NESTED_IF_CHAIN",
  severity: "hint",
  create(context) {
    const coveredExpressions = new Set<string>();
    const coveredStatements = new Set<string>();
    return {
      expression(path) {
        const expression = path.node;
        if (expression.tag !== "if") return;
        if (coveredExpressions.has(spanKey(expression.span))) return;

        const terminalStatement = isTerminalStatement(
          expression,
          path.parent,
          context,
        );
        if (!terminalStatement) return;
        const chain = nestedConditionals(expression, context);
        if (chain.conditionals.length < 2) return;
        for (const nested of chain.conditionals.slice(1)) {
          coveredExpressions.add(spanKey(nested.span));
        }

        let span = expression.span;
        if (terminalStatement) {
          span = statementSpan(expression, context.source);
          coveredStatements.add(spanKey(span));
        }
        if (
          chain.conditionals.some((conditional) =>
            prefersEqualityCase(conditional, context)
          )
        ) return;

        const indent = lineIndent(context.source, span.start);
        context.report({
          message:
            "A conditional directly nested in `else` is one decision ladder; write it as `else if`.",
          span,
          fix: context.fix(
            span,
            "Flatten nested conditional into `else if`",
            renderConditional(chain, context, indent),
          ),
        });
      },
      concrete(rule) {
        if (rule.name !== "conditional_statement") return;
        if (coveredStatements.has(spanKey(rule.span))) return;
        const nested = nestedStatement(rule);
        if (nested === null) return;
        let descendant: Rule | null = nested;
        while (descendant !== null) {
          coveredStatements.add(spanKey(descendant.span));
          descendant = nestedStatement(descendant);
        }
        const indent = lineIndent(context.source, rule.span.start);
        let replacement = flattenStatement(rule, context.source, indent);
        const original = context.source.slice(rule.span.start, rule.span.end);
        if (/\n[ \t]*$/.test(original)) {
          replacement = `${replacement}\n${indent}`;
        }
        context.report({
          message:
            "A statement conditional directly nested in `else` is one decision ladder; write it as `else if`.",
          span: rule.span,
          fix: context.fix(
            rule.span,
            "Flatten nested conditional into `else if`",
            replacement,
          ),
        });
      },
    };
  },
};

interface ConditionalChain {
  readonly conditionals: readonly Extract<Expr, { readonly tag: "if" }>[];
  readonly branches: readonly Branch[];
  readonly fallback: Expr | null;
}

function nestedConditionals(
  expression: Extract<Expr, { readonly tag: "if" }>,
  context: LintRuleContext,
): ConditionalChain {
  const conditionals: Extract<Expr, { readonly tag: "if" }>[] = [];
  const branches: Branch[] = [];
  let current = expression;
  while (true) {
    conditionals.push(current);
    branches.push(...current.branches);
    if (current.fallback === null) {
      return { conditionals, branches, fallback: null };
    }
    const fallback = producedExpression(current.fallback);
    if (fallback.tag !== "if" || !isSurfaceConditional(fallback, context)) {
      return { conditionals, branches, fallback: current.fallback };
    }
    current = fallback;
  }
}

function renderConditional(
  chain: ConditionalChain,
  context: LintRuleContext,
  indent: string,
): string {
  const lines: string[] = [];
  for (let index = 0; index < chain.branches.length; index += 1) {
    const branch = chain.branches[index];
    if (branch === undefined) continue;
    let keyword = "if";
    if (index > 0) keyword = `${indent}else if`;
    lines.push(
      `${keyword} ${singleLine(context.sourceText(branch.condition))}:`,
      ...valueLines(branch.consequence, context.source, `${indent}  `),
    );
  }
  if (chain.fallback !== null) {
    lines.push(
      `${indent}else:`,
      ...valueLines(chain.fallback, context.source, `${indent}  `),
    );
  }
  return lines.join("\n");
}

function valueLines(
  expression: Expr,
  source: string,
  indent: string,
): readonly string[] {
  const body = producedExpression(expression);
  const text = source.slice(body.span.start, body.span.end).trimEnd();
  const originalIndent = lineIndent(source, body.span.start);
  const lines = text.split("\n");
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (line === undefined) continue;
    if (index > 0 && line.startsWith(originalIndent)) {
      line = line.slice(originalIndent.length);
    }
    let prefix = "";
    if (index === 0 && body.tag !== "block") prefix = "return ";
    result.push(`${indent}${prefix}${line}`.trimEnd());
  }
  return result;
}

function nestedStatement(rule: Rule): Rule | null {
  const body = fieldRule(rule, "body");
  if (body === null || body.name !== "conditional_statement_branches") {
    return null;
  }
  const fallback = fieldRule(body, "fallback");
  if (fallback === null) return null;
  const alternative = fieldRule(fallback, "alternative");
  if (alternative === null) return null;
  const statements = fieldRules(alternative, "statements");
  if (statements.length !== 1) return null;
  const statement = statements[0];
  if (statement === undefined) return null;
  return directRule(statement, "conditional_statement");
}

function flattenStatement(
  rule: Rule,
  source: string,
  indent: string,
): string {
  const nested = nestedStatement(rule);
  if (nested === null) {
    return reindentFragment(
      source.slice(rule.span.start, rule.span.end).trimEnd(),
      lineIndent(source, rule.span.start),
      indent,
    );
  }
  const body = fieldRule(rule, "body");
  if (body === null) {
    throw new Error("a checked statement conditional lost its body");
  }
  const fallback = fieldRule(body, "fallback");
  if (fallback === null) {
    throw new Error("a checked nested conditional lost its `else`");
  }
  const prefix = reindentFragment(
    source.slice(rule.span.start, fallback.span.start),
    lineIndent(source, rule.span.start),
    indent,
  ).trimEnd();
  return `${prefix}\n${indent}else ${flattenStatement(nested, source, indent)}`;
}

function reindentFragment(
  fragment: string,
  originalIndent: string,
  indent: string,
): string {
  const lines = fragment.split("\n");
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (line === undefined) continue;
    if (index > 0 && line.startsWith(originalIndent)) {
      line = line.slice(originalIndent.length);
      line = `${indent}${line}`;
    }
    result.push(line);
  }
  return result.join("\n");
}

function isTerminalStatement(
  expression: Extract<Expr, { readonly tag: "if" }>,
  parent: AstNode | null,
  context: LintRuleContext,
): boolean {
  if (
    !context.hasConcreteOrigin(
      expression,
      "conditional_statement_branches",
    )
  ) return false;
  if (parent === null) return false;
  if ("result" in parent && parent.result === expression) return true;
  if ("tag" in parent && parent.tag === "lambda") {
    return parent.body === expression;
  }
  return false;
}

function isSurfaceConditional(
  expression: Extract<Expr, { readonly tag: "if" }>,
  context: LintRuleContext,
): boolean {
  return context.hasConcreteOrigin(
    expression,
    "conditional_statement_branches",
  );
}

function statementSpan(
  expression: Extract<Expr, { readonly tag: "if" }>,
  source: string,
): Span {
  const lineStart = source.lastIndexOf("\n", expression.span.start - 1) + 1;
  const indent = lineIndent(source, expression.span.start);
  const start = lineStart + indent.length;
  if (!source.startsWith("if ", start)) {
    throw new Error("a terminal statement conditional lost its `if` keyword");
  }
  return { start, end: expression.span.end };
}

function singleLine(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, offset));
  if (match === null) return "";
  return match[0];
}
