import type { Expr, Span } from "../../../syntax/ast.ts";
import { producedExpression } from "../syntax.ts";
import type { AstNode, LintRule, LintRuleContext } from "../types.ts";

export const identicalConditionalBranches: LintRule = {
  name: "identical-conditional-branches",
  code: "BLOT_LINT_IDENTICAL_CONDITIONAL_BRANCHES",
  severity: "hint",
  create(context) {
    return {
      expression(path) {
        const expression = path.node;
        if (!isTerminalConditional(expression, path.parent, context)) return;
        const consequence = producedExpression(
          expression.branches[0].consequence,
        );
        const fallback = producedExpression(expression.fallback);
        const value = context.sourceText(consequence);
        if (value.includes("\n") || value !== context.sourceText(fallback)) {
          return;
        }
        const replacement = terminalReplacement(expression, context.source);
        if (replacement === null) return;
        context.report({
          message:
            "Both branches return the same value, so the conditional obscures the result.",
          span: replacement.span,
          fix: context.fix(
            replacement.span,
            "Replace identical branches with their value",
            `let _ = ${
              context.sourceText(expression.branches[0].condition)
            }\n` +
              `${replacement.indentation}return ${value}`,
            "check-interface",
          ),
        });
      },
    };
  },
};

function isTerminalConditional(
  expression: Expr,
  parent: AstNode | null,
  context: LintRuleContext,
): expression is Extract<Expr, { readonly tag: "if" }> & {
  readonly fallback: Expr;
} {
  if (
    expression.tag !== "if" || expression.branches.length !== 1 ||
    expression.fallback === null
  ) return false;
  if (
    !context.hasConcreteOrigin(expression, "conditional_statement_branches")
  ) {
    return false;
  }
  if (parent === null) return false;
  if ("result" in parent && parent.result === expression) return true;
  return "tag" in parent && parent.tag === "lambda" &&
    parent.body === expression;
}

function terminalReplacement(
  expression: Extract<Expr, { readonly tag: "if" }>,
  source: string,
): { readonly span: Span; readonly indentation: string } | null {
  const lineStart = source.lastIndexOf("\n", expression.span.start - 1) + 1;
  const prefix = source.slice(lineStart, expression.span.start);
  const match = /^([ \t]*)if[ \t]+$/.exec(prefix);
  if (match === null) return null;
  return {
    span: { start: lineStart + match[1].length, end: expression.span.end },
    indentation: match[1],
  };
}
