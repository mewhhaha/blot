import { readsDeferredParameter, sourceOperations } from "../operations.ts";
import type { LintRule } from "../types.ts";

export const forwardingCallback: LintRule = {
  name: "forwarding-callback",
  code: "BLOT_LINT_FORWARDING_CALLBACK",
  severity: "hint",
  create(context) {
    return {
      expression({ node, parent, ancestors }) {
        if (
          node.tag !== "lambda" || node.body.tag !== "apply" ||
          parent === null || !("tag" in parent) ||
          (parent.tag !== "tuple" && parent.tag !== "apply") ||
          sourceOperations(context, node)?.forwarding !== true ||
          !context.hasConcreteOrigin(node, "lambda") ||
          readsDeferredParameter(node.body.fn, ancestors)
        ) return;
        context.report({
          message:
            "This callback only forwards its argument to the same strict function.",
          span: node.span,
          fix: context.fix(
            node.span,
            "Pass the function directly",
            context.sourceText(node.body.fn),
            "check-interface",
          ),
        });
      },
    };
  },
};
