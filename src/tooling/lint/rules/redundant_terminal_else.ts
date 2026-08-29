import type { Expr } from "../../../syntax/ast.ts";
import type { Rule } from "../../../syntax/cursor.ts";
import {
  directRule,
  fieldRule,
  fieldRules,
  producedExpression,
  spanKey,
  trailingWhitespace,
} from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

export const redundantTerminalElse: LintRule = {
  name: "redundant-terminal-else",
  code: "BLOT_LINT_REDUNDANT_TERMINAL_ELSE",
  severity: "hint",
  create(context) {
    const eligibleBodies = new Set<string>();
    return {
      expression(path) {
        const expression = path.node;
        if (!isEligibleConditional(expression, context)) return;
        eligibleBodies.add(spanKey(expression.span));
      },
      concrete(rule, ancestors) {
        if (rule.name !== "conditional_statement") return;
        const body = fieldRule(rule, "body");
        if (
          body === null || body.name !== "conditional_statement_branches" ||
          !eligibleBodies.has(spanKey(body.span)) ||
          !isLastStatement(rule, ancestors) ||
          belongsToNestedElse(rule, ancestors)
        ) return;
        if (fieldRules(body, "alternatives").length > 0) return;

        const consequence = fieldRule(body, "consequence");
        const fallback = fieldRule(body, "fallback");
        if (consequence === null || fallback === null) return;
        const consequenceStatements = fieldRules(consequence, "statements");
        const lastConsequence = consequenceStatements.at(-1);
        if (
          lastConsequence === undefined ||
          directRule(lastConsequence, "result") === null
        ) return;
        const alternative = fieldRule(fallback, "alternative");
        if (alternative === null) return;
        const alternativeStatements = fieldRules(alternative, "statements");
        if (
          alternativeStatements.length === 1 &&
          alternativeStatements[0] !== undefined &&
          directRule(alternativeStatements[0], "conditional_statement") !==
            null
        ) return;

        const indent = lineIndent(context.source, rule.span.start);
        const beforeElse = context.source.slice(
          rule.span.start,
          fallback.span.start,
        ).trimEnd();
        const moved = reindentAlternative(
          alternative,
          context.source,
          indent,
        );
        let replacement = beforeElse;
        if (moved.length > 0) replacement = `${replacement}\n${indent}${moved}`;
        replacement += trailingWhitespace(context.source, rule.span);

        context.report({
          message:
            "The first branch already returns, so this terminal `else` only adds nesting.",
          span: rule.span,
          fix: context.fix(
            rule.span,
            "Remove redundant terminal `else`",
            replacement,
            "check-interface",
          ),
        });
      },
    };
  },
};

function isEligibleConditional(
  expression: Expr,
  context: LintRuleContext,
): expression is Extract<Expr, { readonly tag: "if" }> {
  if (
    expression.tag !== "if" || expression.branches.length !== 1 ||
    expression.fallback === null
  ) return false;
  if (
    !context.hasConcreteOrigin(expression, "conditional_statement_branches")
  ) return false;

  const consequence = producedExpression(expression.branches[0].consequence);
  const fallback = producedExpression(expression.fallback);
  if (
    fallback.tag === "if" &&
    context.hasConcreteOrigin(fallback, "conditional_statement_branches")
  ) return false;
  if (context.sourceText(consequence) === context.sourceText(fallback)) {
    return false;
  }
  if (
    consequence.tag === "tag" && consequence.name === "True" &&
    fallback.tag === "tag" && fallback.name === "False"
  ) return false;
  return true;
}

function isLastStatement(
  rule: Rule,
  ancestors: readonly Rule[],
): boolean {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (ancestor === undefined) continue;
    let field = "";
    if (ancestor.name === "program") field = "declarations";
    else if (
      ancestor.name === "do_block" || ancestor.name === "statement_suite"
    ) field = "statements";
    else continue;

    const statements = fieldRules(ancestor, field);
    const last = statements.at(-1);
    if (last === undefined) return false;
    return last.span.start <= rule.span.start && last.span.end >= rule.span.end;
  }
  return false;
}

function belongsToNestedElse(
  rule: Rule,
  ancestors: readonly Rule[],
): boolean {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (
      ancestor === undefined ||
      ancestor.name !== "conditional_statement_else_clause"
    ) continue;
    const alternative = fieldRule(ancestor, "alternative");
    if (alternative === null) return false;
    const statements = fieldRules(alternative, "statements");
    if (statements.length !== 1) return false;
    const statement = statements[0];
    if (statement === undefined) return false;
    return statement.span.start <= rule.span.start &&
      statement.span.end >= rule.span.end;
  }
  return false;
}

function reindentAlternative(
  alternative: Rule,
  source: string,
  indent: string,
): string {
  const originalIndent = lineIndent(source, alternative.span.start);
  const lines = source.slice(
    alternative.span.start,
    alternative.span.end,
  ).trimEnd().split("\n");
  return lines.map((line, index) => {
    if (index === 0) return line;
    if (!line.startsWith(originalIndent)) return line;
    return `${indent}${line.slice(originalIndent.length)}`;
  }).join("\n");
}

function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, offset));
  if (match === null) return "";
  return match[0];
}
