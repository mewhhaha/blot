import { directRule, fieldRules, statementRemovalSpan } from "../syntax.ts";
import type { LintRule } from "../types.ts";

export const terminalContinue: LintRule = {
  name: "terminal-continue",
  code: "BLOT_LINT_TERMINAL_CONTINUE",
  severity: "hint",
  evidence: "syntax-only",
  create(context) {
    return {
      concrete(rule) {
        if (rule.name !== "iteration") return;
        const body = directRule(rule, "statement_suite");
        if (body === null) return;
        const statements = fieldRules(body, "statements");
        const last = statements.at(-1);
        if (statements.length < 2 || last === undefined) return;
        const continuing = directRule(last, "continuing");
        if (continuing === null) return;
        context.report({
          message: "The loop already continues at the end of its body.",
          span: continuing.span,
          fix: context.fix(
            statementRemovalSpan(context.source, continuing.span),
            "Remove terminal continue",
            "",
            "check-interface",
          ),
        });
      },
    };
  },
};
