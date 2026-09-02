import type { CompilerReadabilityFact } from "../../../compiler/wasm.ts";
import type { Span } from "../../../syntax/ast.ts";
import { isRule, type Rule } from "../../../syntax/cursor.ts";
import { directRule, sourceEditSpan, spanKey } from "../syntax.ts";
import type { LintRule } from "../types.ts";

type OpenUsageFact = Extract<
  CompilerReadabilityFact,
  { readonly kind: "open-usage" }
>;

export const unusedOpen: LintRule = {
  name: "unused-open",
  code: "BLOT_LINT_UNUSED_OPEN",
  severity: "hint",
  create(context) {
    const soleSuiteOpenings = new Set<string>();
    collectSoleSuiteOpenings(context.cst, soleSuiteOpenings);
    return {
      declaration(path) {
        const declaration = path.node;
        if (declaration.tag !== "open") return;
        const fact = openUsageFact(context.readability, declaration.value.span);
        if (fact === undefined || fact.used.length > 0) return;
        const editSpan = sourceEditSpan(context.source, declaration.span);
        let fix = context.fix(
          editSpan,
          "Remove unused `open`",
          "",
          "check-interface",
        );
        if (soleSuiteOpenings.has(spanKey(declaration.span))) fix = null;
        context.report({
          message: "This `open` contributes no names to the checked module.",
          span: declaration.span,
          fix,
        });
      },
    };
  },
};

function collectSoleSuiteOpenings(rule: Rule, found: Set<string>): void {
  if (rule.name === "statement_suite" || rule.name === "do_block") {
    const statements = [...rule.children()].filter((child): child is Rule =>
      isRule(child) && child.name === "statement"
    );
    if (statements.length === 1) {
      const opening = directRule(statements[0], "opening");
      if (opening !== null) found.add(spanKey(opening.span));
    }
  }
  for (const child of rule.children()) {
    if (isRule(child)) collectSoleSuiteOpenings(child, found);
  }
}

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
