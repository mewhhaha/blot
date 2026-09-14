import { sourceOperations } from "../operations.ts";
import type { LintRule } from "../types.ts";

export const publicPrimitive: LintRule = {
  name: "public-primitive",
  code: "BLOT_LINT_PUBLIC_PRIMITIVE",
  severity: "hint",
  create(context) {
    return {
      expression({ node }) {
        if (node.tag !== "intrinsic") return;
        const alias = sourceOperations(context, node)?.primitiveAlias;
        if (alias === undefined || alias === null) return;
        context.report({
          message: "The public operation " + alias +
            " names this same primitive.",
          span: node.span,
          fix: context.fix(node.span, "Use " + alias, alias, "check-interface"),
        });
      },
    };
  },
};
