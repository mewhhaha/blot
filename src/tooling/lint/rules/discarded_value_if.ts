import type { Expr } from "../../../syntax/ast.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

export const discardedValueIf: LintRule = {
  name: "discarded-value-if",
  code: "BLOT_LINT_DISCARDED_VALUE_IF",
  severity: "hint",
  create(context) {
    return {
      declaration(path) {
        const declaration = path.node;
        if (declaration.tag !== "binding" || declaration.kind !== "effect") {
          return;
        }
        if (!context.hasConcreteOrigin(declaration, "rebinding")) return;
        if (
          declaration.pattern.tag !== "name" ||
          declaration.pattern.name !== "_"
        ) return;
        if (
          declaration.value.tag !== "if" ||
          !context.isValueConditional(declaration.value)
        ) return;
        if (!unitConditional(declaration.value)) return;
        const valueSource = context.source.slice(
          declaration.value.span.start,
          declaration.value.span.end,
        );
        const replacement = valueSource.replace(
          /(^|\n)[ \t]*return[ \t]+\(\)[ \t]*(?:\n|$)/g,
          "$1",
        );
        context.report({
          message:
            "This value conditional is discarded; use a standalone `if` suite.",
          span: declaration.span,
          fix: context.fix(
            declaration.span,
            "Replace discarded value conditional with standalone `if`",
            replacement,
          ),
        });
      },
    };
  },
};

function unitConditional(
  expression: Extract<Expr, { readonly tag: "if" }>,
): boolean {
  if (expression.fallback === null) return false;
  return expression.branches.every((branch) => unitSuite(branch.consequence)) &&
    unitSuite(expression.fallback);
}

function unitSuite(expression: Expr): boolean {
  return expression.tag === "block" && expression.declarations.length > 0 &&
    expression.result.tag === "unit";
}
