import type { Decl, Expr } from "../../../syntax/ast.ts";
import { statementRemovalSpan } from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

export const terminalValueForwarding: LintRule = {
  name: "terminal-value-forwarding",
  code: "BLOT_LINT_TERMINAL_VALUE_FORWARDING",
  severity: "hint",
  evidence: "syntax-only",
  create(context) {
    return {
      module: ({ node }) => inspect(node.declarations, node.result, context),
      expression({ node }) {
        if (node.tag === "block") {
          inspect(node.declarations, node.result, context);
        }
      },
    };
  },
};

function inspect(
  declarations: readonly Decl[],
  result: Expr,
  context: LintRuleContext,
): void {
  const last = declarations.at(-1);
  if (
    last === undefined || last.tag !== "binding" || last.kind !== "let" ||
    last.tags.length !== 0 || last.pattern.tag !== "name" ||
    last.pattern.qualifier !== "none" ||
    result.tag !== "var" || result.name !== last.pattern.name ||
    declarations.at(-2)?.tag === "signature" ||
    !context.hasConcreteOrigin(last, "binding")
  ) return;
  const value = context.sourceText(last.value);
  if (value.includes("\n")) return;
  context.report({
    message:
      "This final binding only names the returned value; return its expression directly.",
    span: last.span,
    fix: context.fixEdits({
      title: "Return the value directly",
      kind: "quickfix",
      validation: "check-interface",
      edits: [
        {
          span: statementRemovalSpan(context.source, last.span),
          replacement: "",
        },
        { span: result.span, replacement: "(" + value + ")" },
      ],
    }),
  });
}
