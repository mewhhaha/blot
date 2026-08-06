import { producedExpression } from "../syntax.ts";
import type { LintRule } from "../types.ts";

export const redundantIf: LintRule = {
  name: "redundant-if",
  code: "BLOT_LINT_REDUNDANT_IF",
  severity: "hint",
  create(context) {
    return {
      expression(path) {
        const expression = path.node;
        if (
          expression.tag !== "if" || !context.isValueConditional(expression)
        ) return;
        if (expression.fallback === null) return;
        const fallback = context.sourceText(
          producedExpression(expression.fallback),
        );
        if (
          expression.branches.some((branch) =>
            context.sourceText(producedExpression(branch.consequence)) !==
              fallback
          )
        ) return;
        context.report({
          message:
            "Every branch produces the same expression; remove the conditional.",
          span: expression.span,
          fix: context.fix(
            expression.span,
            "Remove redundant conditional",
            fallback,
          ),
        });
      },
    };
  },
};
