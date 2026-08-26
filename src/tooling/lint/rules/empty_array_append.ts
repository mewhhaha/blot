import type { Expr } from "../../../syntax/ast.ts";
import { binaryCall, calleePath } from "../syntax.ts";
import type { LintRule } from "../types.ts";

export const emptyArrayAppend: LintRule = {
  name: "empty-array-append",
  code: "BLOT_LINT_EMPTY_ARRAY_APPEND",
  severity: "hint",
  create(context) {
    return {
      expression(path) {
        const call = binaryCall(path.node);
        if (
          call === null || calleePath(call.callee)?.join(".") !== "Array.append"
        ) return;
        let value = call.left;
        if (isEmptyArray(call.left)) value = call.right;
        else if (!isEmptyArray(call.right)) return;
        context.report({
          message:
            "Appending an empty array performs no useful work; use the other array directly.",
          span: path.node.span,
          fix: context.fix(
            path.node.span,
            "Remove empty array append",
            context.sourceText(value),
            "check-interface",
          ),
        });
      },
    };
  },
};

function isEmptyArray(expression: Expr): boolean {
  return expression.tag === "array" && expression.elements.length === 0;
}
