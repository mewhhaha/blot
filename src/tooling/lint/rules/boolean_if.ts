import { producedExpression } from "../syntax.ts";
import type { LintRule } from "../types.ts";

export const booleanIf: LintRule = {
  name: "boolean-if",
  code: "BLOT_LINT_BOOLEAN_IF",
  severity: "hint",
  create(context) {
    return {
      expression(path) {
        const expression = path.node;
        if (
          expression.tag !== "if" || !context.isValueConditional(expression)
        ) return;
        if (expression.branches.length !== 1 || expression.fallback === null) {
          return;
        }
        const consequence = producedExpression(
          expression.branches[0].consequence,
        );
        const fallback = producedExpression(expression.fallback);
        if (!isBoolean(consequence, "True") || !isBoolean(fallback, "False")) {
          return;
        }
        const condition = context.sourceText(expression.branches[0].condition);
        context.report({
          message: "This conditional only reproduces its Boolean condition.",
          span: expression.span,
          fix: context.fix(
            expression.span,
            "Replace conditional with its condition",
            condition,
          ),
        });
      },
    };
  },
};

function isBoolean(
  expression: ReturnType<typeof producedExpression>,
  name: "True" | "False",
): boolean {
  return expression.tag === "tag" && expression.name === name;
}
