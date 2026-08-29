import type { Expr } from "../../../syntax/ast.ts";
import {
  binaryCall,
  producedExpression,
  trailingWhitespace,
} from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

interface EqualityMatch {
  readonly subject: string;
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

        const comparisons = equalityMatches(
          expression.branches[0].condition,
          context,
        );
        if (comparisons === null) return;
        const subjects = comparisons.map((comparison) => comparison.subject);
        const subjectList = subjects.join(", ");
        const indent = lineIndent(context.source, expression.span.start);
        const replacement = renderCase(
          subjects,
          comparisons.map((comparison) => comparison.pattern),
          expression.branches[0].consequence,
          expression.fallback,
          context,
          indent,
        ) + trailingWhitespace(context.source, expression.span);
        context.report({
          message:
            `Match ${subjectList} directly instead of matching a derived Boolean.`,
          span: expression.span,
          fix: context.fix(
            expression.span,
            "Match the compared values directly",
            replacement,
            "check",
          ),
        });
      },
    };
  },
};

function equalityMatches(
  condition: Expr,
  context: LintRuleContext,
): readonly EqualityMatch[] | null {
  const fact = context.simplifications.find((candidate) =>
    sameSpan(candidate.span, condition.span)
  );
  if (fact?.kind === "integer-equality") {
    let pattern: string;
    if (fact.pattern.kind === "integer-literal") {
      pattern = singleLine(
        context.source.slice(fact.pattern.span.start, fact.pattern.span.end),
      );
    } else {
      pattern = `^${fact.pattern.name}`;
    }
    return [{
      subject: singleLine(
        context.source.slice(fact.subject.start, fact.subject.end),
      ),
      pattern,
    }];
  }
  if (fact?.kind !== "short-circuit-and") return null;

  const conjunction = binaryCall(condition);
  if (conjunction === null) return null;
  if (
    !sameSpan(conjunction.left.span, fact.left) ||
    !sameSpan(conjunction.right.span, fact.right)
  ) return null;

  const left = equalityMatches(conjunction.left, context);
  if (left === null) return null;
  const right = equalityMatches(conjunction.right, context);
  if (right === null) return null;
  return [...left, ...right];
}

function sameSpan(
  left: { readonly start: number; readonly end: number },
  right: { readonly start: number; readonly end: number },
): boolean {
  return left.start === right.start && left.end === right.end;
}

function renderCase(
  subjects: readonly string[],
  patterns: readonly string[],
  consequence: Expr,
  fallback: Expr,
  context: LintRuleContext,
  indent: string,
): string {
  const armIndent = `${indent}  `;
  const subjectList = subjects.join(", ");
  const matchedPatterns = patterns.join(", ");
  const fallbackPatterns = subjects.map(() => "_").join(", ");
  return `case ${subjectList} of\n${
    renderArm(matchedPatterns, consequence, context, armIndent)
  }\n${renderArm(fallbackPatterns, fallback, context, armIndent)}`;
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
