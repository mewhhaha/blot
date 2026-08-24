import type { LintRule } from "../types.ts";

export const specializationCount: LintRule = {
  name: "specialization-count",
  code: "BLOT_LINT_SPECIALIZATION_COUNT",
  severity: "hint",
  create(context) {
    return {
      module() {
        for (const fact of context.specializations) {
          if (fact.specializationCount < fact.softLimit) continue;
          let name = "This binding";
          if (fact.binding.name !== null) name = `\`${fact.binding.name}\``;
          const largest = fact.keys
            .map((key) => key.representation)
            .slice(0, 3)
            .join(", ");
          context.report({
            message:
              `${name} has ${fact.specializationCount} compiler-confirmed runtime representations (${largest}). Narrow its structural parameter, add a public signature, move compile-time data to runtime, or introduce a stable representation.`,
            span: fact.binding.span,
          });
        }
      },
    };
  },
};
