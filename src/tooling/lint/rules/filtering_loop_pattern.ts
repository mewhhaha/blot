import {
  directRule,
  fieldRule,
  fieldRules,
  statementRemovalSpan,
} from "../syntax.ts";
import type { LintRule } from "../types.ts";

export const filteringLoopPattern: LintRule = {
  name: "filtering-loop-pattern",
  code: "BLOT_LINT_FILTERING_LOOP_PATTERN",
  severity: "hint",
  evidence: "syntax-only",
  create(context) {
    return {
      concrete(rule) {
        if (rule.name !== "iteration") return;
        const head = fieldRule(rule, "head");
        const body = fieldRule(rule, "body");
        if (
          head === null || body === null ||
          rule.field("kind") !== null && rule.field("kind") !== undefined
        ) return;
        const name = context.sourceText(head);
        if (!/^[a-z_][A-Za-z0-9_]*$/.test(name)) return;
        const first = fieldRules(body, "statements")[0];
        if (first === undefined) return;
        const conditional = directRule(first, "conditional_statement");
        if (conditional === null) return;
        const guard = directRule(conditional, "conditional_statement_guard");
        if (guard === null) return;
        const pattern = fieldRule(guard, "pattern");
        const value = fieldRule(guard, "value");
        const failure = fieldRule(guard, "alternative");
        if (
          pattern === null || value === null || failure === null ||
          context.sourceText(value) !== name
        ) return;
        const failureStatements = fieldRules(failure, "statements");
        if (
          failureStatements.length !== 1 ||
          directRule(failureStatements[0], "continuing") === null
        ) return;
        const later = context.source.slice(first.span.end, body.span.end);
        if (new RegExp("\\b" + name + "\\b").test(later)) return;
        context.report({
          message:
            "This loop skips precisely the elements that do not match its first guard.",
          span: first.span,
          fix: context.fixEdits({
            title: "Use a filtering loop pattern",
            kind: "quickfix",
            validation: "check-interface",
            edits: [
              {
                span: head.span,
                replacement: "case " + context.sourceText(pattern),
              },
              {
                span: statementRemovalSpan(context.source, first.span),
                replacement: "",
              },
            ],
          }),
        });
      },
    };
  },
};
