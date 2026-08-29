import type { Expr } from "../../../syntax/ast.ts";
import {
  binaryCall,
  calleePath,
  producedExpression,
  trailingWhitespace,
} from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

interface EqualityMatch {
  readonly subject: Expr;
  readonly pattern: string;
}

export const equalityCase: LintRule = {
  name: "equality-case",
  code: "BLOT_LINT_EQUALITY_CASE",
  severity: "hint",
  create(context) {
    return {
      expression(path) {
        const expression = path.node;
        if (
          expression.tag !== "if" || expression.branches.length !== 1 ||
          expression.fallback === null
        ) return;
        if (!context.hasConcreteOrigin(expression, "case_expression")) return;
        if (
          context.concreteHasDescendant(
            expression,
            "case_expression",
            "case_guard",
          )
        ) return;

        const comparison = equalityMatch(
          expression.branches[0].condition,
          context,
        );
        if (comparison === null) return;
        const subject = singleLine(context.sourceText(comparison.subject));
        const indent = lineIndent(context.source, expression.span.start);
        const replacement = renderCase(
          subject,
          comparison.pattern,
          expression.branches[0].consequence,
          expression.fallback,
          context,
          indent,
        ) + trailingWhitespace(context.source, expression.span);
        context.report({
          message:
            `Match ${subject} directly instead of matching the Boolean result of its equality comparison.`,
          span: expression.span,
          fix: context.fix(
            expression.span,
            "Match the compared value directly",
            replacement,
            "check",
          ),
        });
      },
    };
  },
};

function equalityMatch(
  condition: Expr,
  context: LintRuleContext,
): EqualityMatch | null {
  const call = binaryCall(condition);
  if (call === null || calleePath(call.callee)?.join(".") !== "Int.eq") {
    return null;
  }
  const operator = context.source.slice(
    call.left.span.end,
    call.right.span.start,
  )
    .trim();
  if (operator !== "==") return null;
  const leftPattern = call.left.tag === "int";
  const rightPattern = call.right.tag === "int";
  if (leftPattern !== rightPattern) {
    if (rightPattern) {
      return {
        subject: call.left,
        pattern: singleLine(context.sourceText(call.right)),
      };
    }
    return {
      subject: call.right,
      pattern: singleLine(context.sourceText(call.left)),
    };
  }
  if (call.left.tag === "var" && isComputedSubject(call.right)) {
    return { subject: call.right, pattern: `^${call.left.name}` };
  }
  if (call.right.tag === "var" && isComputedSubject(call.left)) {
    return { subject: call.left, pattern: `^${call.right.name}` };
  }
  return null;
}

function isComputedSubject(expression: Expr): boolean {
  return expression.tag === "apply" || expression.tag === "field";
}

function renderCase(
  subject: string,
  pattern: string,
  consequence: Expr,
  fallback: Expr,
  context: LintRuleContext,
  indent: string,
): string {
  const armIndent = `${indent}  `;
  return `case ${subject} of\n${
    renderArm(pattern, consequence, context, armIndent)
  }\n${renderArm("_", fallback, context, armIndent)}`;
}

function renderArm(
  pattern: string,
  expression: Expr,
  context: LintRuleContext,
  indent: string,
): string {
  const body = producedExpression(expression);
  const source = context.sourceText(body).trimEnd();
  const lines = source.split("\n");
  const first = lines[0]?.trimStart();
  if (first === undefined) {
    throw new Error("an equality case lost its arm body");
  }
  if (lines.length === 1) return `${indent}${pattern} => ${first}`;

  const continuationIndent = smallestIndent(lines.slice(1));
  const rendered = [`${indent}${pattern} => ${first}`];
  for (const line of lines.slice(1)) {
    let content = line;
    if (content.startsWith(continuationIndent)) {
      content = content.slice(continuationIndent.length);
    }
    rendered.push(`${indent}  ${content}`.trimEnd());
  }
  return rendered.join("\n");
}

function smallestIndent(lines: readonly string[]): string {
  let smallest: string | null = null;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const match = /^[ \t]*/.exec(line);
    let indent = "";
    if (match !== null && match[0] !== undefined) indent = match[0];
    if (smallest === null || indent.length < smallest.length) smallest = indent;
  }
  if (smallest === null) return "";
  return smallest;
}

function singleLine(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, offset));
  if (match === null || match[0] === undefined) return "";
  return match[0];
}
