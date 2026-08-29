import type { Expr } from "../../../syntax/ast.ts";
import { producedExpression, trailingWhitespace } from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

export const discardedBooleanCase: LintRule = {
  name: "discarded-boolean-case",
  code: "BLOT_LINT_DISCARDED_BOOLEAN_CASE",
  severity: "hint",
  create(context) {
    return {
      declaration(path) {
        const declaration = path.node;
        if (
          declaration.tag !== "binding" || declaration.kind !== "effect" ||
          declaration.pattern.tag !== "wildcard"
        ) return;
        if (!context.hasConcreteOrigin(declaration, "sequencing")) return;
        const expression = declaration.value;
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

        const consequence = producedExpression(
          expression.branches[0].consequence,
        );
        const fallback = producedExpression(expression.fallback);
        const trueDoesNothing = consequence.tag === "unit";
        const falseDoesNothing = fallback.tag === "unit";
        if (trueDoesNothing === falseDoesNothing) return;

        const condition = singleLine(
          context.sourceText(expression.branches[0].condition),
        );
        let activeCondition = condition;
        let activeBody = consequence;
        if (trueDoesNothing) {
          activeCondition = `not (${condition})`;
          activeBody = fallback;
        }
        const indent = lineIndent(context.source, declaration.span.start);
        const replacement =
          `if ${activeCondition}:\n${
            renderEffect(activeBody, context, `${indent}  `)
          }` + trailingWhitespace(context.source, declaration.span);
        context.report({
          message:
            "This discarded Boolean case only decides whether an effect runs; use a statement `if`.",
          span: declaration.span,
          fix: context.fix(
            declaration.span,
            "Replace discarded Boolean case with `if`",
            replacement,
            "check",
          ),
        });
      },
    };
  },
};

function renderEffect(
  expression: Expr,
  context: LintRuleContext,
  indent: string,
): string {
  const source = context.sourceText(expression).trimEnd();
  const lines = source.split("\n");
  const first = lines[0]?.trimStart();
  if (first === undefined) {
    throw new Error("a discarded Boolean case lost its active body");
  }
  const rendered = [`${indent}use ${first}`];
  if (lines.length === 1) return rendered[0];

  const continuationIndent = smallestIndent(lines.slice(1));
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
