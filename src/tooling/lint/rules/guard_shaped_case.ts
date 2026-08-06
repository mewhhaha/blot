import type { Arm, Expr, Span } from "../../../syntax/ast.ts";
import { producedExpression } from "../syntax.ts";
import type { AstNode, LintRule, LintRuleContext } from "../types.ts";

export const guardShapedCase: LintRule = {
  name: "guard-shaped-case",
  code: "BLOT_LINT_GUARD_SHAPED_CASE",
  severity: "hint",
  create(context) {
    return {
      expression(path) {
        const expression = path.node;
        if (expression.tag !== "case" || expression.arms.length !== 2) return;
        if (!context.hasConcreteOrigin(expression, "case_expression")) return;
        if (
          context.concreteHasDescendant(
            expression,
            "case_expression",
            "case_guard",
          )
        ) return;
        if (!isTerminal(expression, path.parent)) return;
        const none = expression.arms.find((arm) => constructor(arm, "None"));
        const some = expression.arms.find((arm) => constructor(arm, "Some"));
        if (none === undefined || some === undefined) return;
        if (!leavesScope(none, context.source)) return;
        context.report({
          message:
            "This Option match has one leaving failure arm; prefer an `if let #Some … else:` guard when the success path continues in the surrounding scope.",
          span: expression.span,
          fix: guardFix(expression, none, some, path.parent, context),
        });
      },
    };
  },
};

function isTerminal(
  expression: Arm["body"],
  parent: AstNode | null,
): boolean {
  if (parent === null) return false;
  if ("result" in parent && parent.result === expression) return true;
  if (
    "tag" in parent && parent.tag === "lambda" && parent.body === expression
  ) {
    return true;
  }
  return false;
}

function guardFix(
  expression: Extract<Expr, { readonly tag: "case" }>,
  none: Arm,
  some: Arm,
  parent: AstNode | null,
  context: LintRuleContext,
) {
  if (!isTerminal(expression, parent)) return null;
  const failure = producedExpression(none.body);
  const success = producedExpression(some.body);
  if (failure.tag === "block" || success.tag === "block") return null;
  const failureSource = context.source.slice(
    none.pattern.span.end,
    none.body.span.end,
  );
  if (!/(^|\n)[ \t]*return\b/.test(failureSource)) return null;

  const lineStart =
    context.source.lastIndexOf("\n", expression.span.start - 1) + 1;
  const prefix = context.source.slice(lineStart, expression.span.start);
  const returned = /^([ \t]*)return[ \t]+$/.exec(prefix);
  if (returned === null) return null;
  const indent = returned[1];
  const span: Span = {
    start: lineStart + indent.length,
    end: expression.span.end,
  };
  const replacement =
    `if let ${context.sourceText(some.pattern)} = ${
      context.sourceText(expression.target)
    } else:\n` +
    `${indent}  return ${context.sourceText(failure)}\n` +
    `${indent}return ${context.sourceText(success)}`;
  return context.fix(
    span,
    "Replace Option match with `if let` guard",
    replacement,
    "check-interface",
  );
}

function constructor(arm: Arm, name: string): boolean {
  return arm.pattern.tag === "constructor" && arm.pattern.name === name;
}

function leavesScope(
  arm: Arm,
  source: string,
): boolean {
  const text = source.slice(arm.pattern.span.end, arm.body.span.end);
  return /(^|\n)[ \t]*(return|break)\b/.test(text);
}
