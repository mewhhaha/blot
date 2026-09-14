import { spanKey } from "../syntax.ts";
import type { LintRule } from "../types.ts";

export const selectiveOpen: LintRule = {
  name: "selective-open",
  code: "BLOT_LINT_SELECTIVE_OPEN",
  severity: "hint",
  create(context) {
    return {
      declaration({ node }) {
        if (
          node.tag !== "open" || !context.hasConcreteOrigin(node, "opening")
        ) return;
        const fact = context.readability.find((fact) =>
          fact.kind === "open-usage" &&
          spanKey(fact.span) === spanKey(node.value.span)
        );
        if (
          fact?.kind !== "open-usage" || fact.used.length === 0 ||
          fact.used.length > 3 ||
          fact.used.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        ) return;
        const source = context.sourceText(node.value);
        if (source.includes("\n")) return;
        const fields = fact.used.map((name) => "." + name + ";").join(" ");
        context.report({
          message: "Only these fields are used from this opening: " +
            fact.used.join(", ") + ".",
          span: node.span,
          fix: context.fix(
            node.span,
            "Import only the used fields",
            "const { " + fields + " } = " + source + "\n",
            "check-interface",
          ),
        });
      },
    };
  },
};
