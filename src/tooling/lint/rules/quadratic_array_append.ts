import type { Expr } from "../../../syntax/ast.ts";
import { binaryCall, calleePath } from "../syntax.ts";
import type { AstNode, LintRule } from "../types.ts";

export const quadraticArrayAppend: LintRule = {
  name: "quadratic-array-append",
  code: "BLOT_LINT_QUADRATIC_ARRAY_APPEND",
  severity: "warning",
  create(context) {
    return {
      expression(path) {
        const call = binaryCall(path.node);
        if (
          call === null || calleePath(call.callee)?.join(".") !== "Array.append"
        ) return;
        if (call.right.tag !== "array" || call.right.elements.length !== 1) {
          return;
        }
        if (call.right.elements[0].spread || !insideFold(path.ancestors)) {
          return;
        }
        const value = call.right.elements[0].value;
        context.report({
          message:
            "Appending a singleton on every fold step repeatedly copies the accumulated prefix; push the element instead.",
          span: path.node.span,
          fix: context.fix(
            path.node.span,
            "Replace singleton append with `Array.push`",
            `Array.push (${context.sourceText(call.left)}, ${
              context.sourceText(value)
            })`,
          ),
        });
      },
    };
  },
};

function insideFold(ancestors: readonly AstNode[]): boolean {
  return ancestors.some((ancestor) => {
    if (!isExpression(ancestor) || ancestor.tag !== "apply") return false;
    return calleePath(ancestor.fn)?.join(".") === "fold";
  });
}

function isExpression(node: AstNode): node is Expr {
  return "tag" in node && node.tag !== "binding" && node.tag !== "shadow" &&
    node.tag !== "open" && !("declarations" in node && "resultEffects" in node);
}
