import type { Expr, Pattern } from "../../../syntax/ast.ts";
import type { LintRule } from "../types.ts";

export const identityVariantCase: LintRule = {
  name: "identity-variant-case",
  code: "BLOT_LINT_IDENTITY_VARIANT_CASE",
  severity: "hint",
  evidence: "syntax-only",
  create(context) {
    return {
      expression({ node }) {
        if (
          node.tag !== "case" || node.arms.length < 2 ||
          !context.hasConcreteOrigin(node, "case_expression") ||
          !node.arms.every((arm) => reconstructs(arm.pattern, arm.body))
        ) return;
        context.report({
          message: "Every arm returns its input constructor unchanged.",
          span: node.span,
          fix: context.fix(
            node.span,
            "Use the original variant",
            "(" + context.sourceText(node.target) + ")",
            "check-interface",
          ),
        });
      },
    };
  },
};

function reconstructs(pattern: Pattern, expression: Expr): boolean {
  if (pattern.tag !== "constructor") return false;
  if (pattern.payload === null) {
    return expression.tag === "tag" && expression.name === pattern.name;
  }
  return pattern.payload.tag === "name" &&
    pattern.payload.qualifier === "none" &&
    expression.tag === "apply" && expression.fn.tag === "tag" &&
    expression.fn.name === pattern.name && expression.arg.tag === "var" &&
    expression.arg.name === pattern.payload.name;
}
