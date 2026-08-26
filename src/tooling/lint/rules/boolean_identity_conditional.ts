import type { Expr, Span } from "../../../syntax/ast.ts";
import { producedExpression } from "../syntax.ts";
import type { AstNode, LintRule, LintRuleContext } from "../types.ts";

export const booleanIdentityConditional: LintRule = {
  name: "boolean-identity-conditional",
  code: "BLOT_LINT_BOOLEAN_IDENTITY_CONDITIONAL",
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
        if (!isBooleanTag(consequence, "True")) return;
        if (!isBooleanTag(fallback, "False")) return;
        const replacement = terminalReplacement(expression, context.source);
        if (replacement === null) return;
        context.report({
          message:
            "This conditional returns its Boolean condition unchanged; return the condition directly.",
          span: replacement.span,
          fix: context.fix(
            replacement.span,
            "Return the Boolean condition directly",
            `return ${context.sourceText(expression.branches[0].condition)}`,
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

function isBooleanTag(expression: Expr, name: "True" | "False"): boolean {
  return expression.tag === "tag" && expression.name === name;
}

function terminalReplacement(
  expression: Extract<Expr, { readonly tag: "if" }>,
  source: string,
): { readonly span: Span } | null {
  const lineStart = source.lastIndexOf("\n", expression.span.start - 1) + 1;
  const prefix = source.slice(lineStart, expression.span.start);
  const match = /^([ \t]*)if[ \t]+$/.exec(prefix);
  if (match === null) return null;
  return {
    span: { start: lineStart + match[1].length, end: expression.span.end },
  };
}
