import type { Pattern } from "../../../syntax/ast.ts";
import { patternKey } from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

export const unreachableCaseArm: LintRule = {
  name: "unreachable-case-arm",
  code: "BLOT_LINT_UNREACHABLE_CASE_ARM",
  severity: "warning",
  create(context) {
    return {
      expression(path) {
        const expression = path.node;
        if (expression.tag !== "case") return;
        if (!context.hasConcreteOrigin(expression, "case_expression")) return;
        if (
          context.concreteHasDescendant(
            expression,
            "case_expression",
            "case_guard",
          )
        ) return;
        const covered = new Set<string>();
        let exhaustive = false;
        for (const arm of expression.arms) {
          const guarded = hasGuard(arm.pattern, arm.body.span.start, context);
          const key = patternKey(arm.pattern);
          if (exhaustive || (key !== null && covered.has(key))) {
            context.report({
              message:
                "This case arm cannot be selected because an earlier arm already matches it.",
              span: arm.pattern.span,
              fix: context.fix(
                { start: arm.pattern.span.start, end: arm.body.span.end },
                "Remove unreachable case arm",
                "",
              ),
            });
            continue;
          }
          if (guarded || key === null) continue;
          covered.add(key);
          if (key === "*") exhaustive = true;
        }
      },
    };
  },
};

function hasGuard(
  pattern: Pattern,
  bodyStart: number,
  context: LintRuleContext,
): boolean {
  const between = context.source.slice(pattern.span.end, bodyStart);
  return /\bif\b/.test(between.slice(0, between.lastIndexOf("=>")));
}
