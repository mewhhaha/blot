import type { LintRule } from "../types.ts";

export const fieldShorthand: LintRule = {
  name: "field-shorthand",
  code: "BLOT_LINT_FIELD_SHORTHAND",
  severity: "hint",
  evidence: "syntax-only",
  create(context) {
    return {
      concrete(rule) {
        if (
          rule.name !== "shape_field" && rule.name !== "shape_pattern_field"
        ) return;
        const spelling = context.sourceText(rule);
        const matched = /^\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\1\s*;$/.exec(
          spelling,
        );
        if (matched === null) return;
        context.report({
          message: "This field repeats its binding name; use field shorthand.",
          span: rule.span,
          fix: context.fix(
            rule.span,
            "Use field shorthand",
            "." + matched[1] + ";",
          ),
        });
      },
    };
  },
};
