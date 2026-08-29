import type { CompilerReadabilityFact } from "../../../compiler/wasm.ts";
import type { Span } from "../../../syntax/ast.ts";
import type { LintRule } from "../types.ts";

type OpenUsageFact = Extract<
  CompilerReadabilityFact,
  { readonly kind: "open-usage" }
>;

export const openShadow: LintRule = {
  name: "open-shadow",
  code: "BLOT_LINT_OPEN_SHADOW",
  severity: "hint",
  create(context) {
    return {
      declaration(path) {
        const declaration = path.node;
        if (declaration.tag !== "open") return;
        const fact = openUsageFact(context.readability, declaration.value.span);
        if (
          fact === undefined || fact.used.length === 0 ||
          fact.shadowed.length === 0
        ) return;
        const names = fact.shadowed.map((name) => `\`${name}\``).join(", ");
        let message =
          `This \`open\` shadows the previously visible name ${names}.`;
        if (fact.shadowed.length > 1) {
          message =
            `This \`open\` shadows the previously visible names ${names}.`;
        }
        context.report({
          message,
          span: declaration.span,
        });
      },
    };
  },
};

function openUsageFact(
  facts: readonly CompilerReadabilityFact[],
  span: Span,
): OpenUsageFact | undefined {
  return facts.find((fact): fact is OpenUsageFact =>
    fact.kind === "open-usage" && sameSpan(fact.span, span)
  );
}

function sameSpan(left: Span, right: Span): boolean {
  return left.start === right.start && left.end === right.end;
}
