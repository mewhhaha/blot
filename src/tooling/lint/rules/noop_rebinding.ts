import type { LintRule } from "../types.ts";

export const noopRebinding: LintRule = {
  name: "noop-rebinding",
  code: "BLOT_LINT_NOOP_REBINDING",
  severity: "warning",
  create(context) {
    return {
      declaration(path) {
        const declaration = path.node;
        if (declaration.tag !== "shadow" || declaration.value.tag !== "var") {
          return;
        }
        if (!context.hasConcreteOrigin(declaration, "rebinding")) return;
        if (declaration.value.name !== declaration.name) return;
        const source = context.source.slice(
          declaration.span.start,
          declaration.value.span.start,
        );
        if (!source.includes(":=")) return;
        context.report({
          message: `Rebinding \`${declaration.name}\` to itself has no effect.`,
          span: declaration.span,
          fix: context.fix(
            declaration.span,
            "Remove no-op rebinding",
            "",
            "check-interface",
          ),
        });
      },
    };
  },
};
