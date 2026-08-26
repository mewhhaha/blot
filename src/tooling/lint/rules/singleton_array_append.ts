import type { Expr } from "../../../syntax/ast.ts";
import { binaryCall, calleePath } from "../syntax.ts";
import type { AstNode, LintRule } from "../types.ts";

export const singletonArrayAppend: LintRule = {
  name: "singleton-array-append",
  code: "BLOT_LINT_SINGLETON_ARRAY_APPEND",
  severity: "hint",
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
        const element = call.right.elements[0];
        if (element.spread || insideFold(path.ancestors)) return;
        context.report({
          message:
            "Appending a singleton array allocates an intermediate array; push the element directly.",
          span: path.node.span,
          fix: context.fix(
            path.node.span,
            "Replace singleton append with `Array.push`",
            `Array.push (${context.sourceText(call.left)}, ${
              context.sourceText(element.value)
            })`,
            "check-interface",
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
