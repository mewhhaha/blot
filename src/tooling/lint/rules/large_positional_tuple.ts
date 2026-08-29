import type { Pattern } from "../../../syntax/ast.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

const MAXIMUM_POSITIONAL_PARAMETERS = 4;

export const largePositionalTuple: LintRule = {
  name: "large-positional-tuple",
  code: "BLOT_LINT_LARGE_POSITIONAL_TUPLE",
  severity: "hint",
  create(context) {
    return {
      module(path) {
        if (path.node.parameter === null) return;
        reportLargePositionalParameter(path.node.parameter, context);
      },
      expression(path) {
        const expression = path.node;
        if (expression.tag !== "lambda") return;
        reportLargePositionalParameter(expression.parameter, context);
      },
    };
  },
};

function reportLargePositionalParameter(
  parameter: Pattern,
  context: LintRuleContext,
): void {
  if (
    parameter.tag !== "tuple" ||
    parameter.elements.length <= MAXIMUM_POSITIONAL_PARAMETERS
  ) return;
  if (!context.hasConcreteOrigin(parameter, "tuple_pattern")) return;

  context.report({
    message:
      `This parameter destructures ${parameter.elements.length} positional values; prefer a record with named fields.`,
    span: parameter.span,
  });
}
