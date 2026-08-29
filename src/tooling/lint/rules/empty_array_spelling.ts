import type { Span } from "../../../syntax/ast.ts";
import type { LintRule } from "../types.ts";

export const emptyArraySpelling: LintRule = {
  name: "empty-array-spelling",
  code: "BLOT_LINT_EMPTY_ARRAY_SPELLING",
  severity: "hint",
  create(context) {
    return {
      expression(path) {
        const expression = path.node;
        if (expression.tag === "var") return;
        if (
          expression.tag === "array" && expression.elements.length === 0
        ) return;
        if (!context.hasConcreteOrigin(expression, "expression")) return;
        if (
          !context.readability.some((fact) =>
            fact.kind === "empty-array" && sameSpan(fact.span, expression.span)
          )
        ) return;
        context.report({
          message:
            "The compiler proves this value is an empty array; spell it as `[]`.",
          span: expression.span,
          fix: context.fix(
            expression.span,
            "Replace with empty array literal",
            "[]",
            "check-interface",
          ),
        });
      },
    };
  },
};

function sameSpan(left: Span, right: Span): boolean {
  return left.start === right.start && left.end === right.end;
}
