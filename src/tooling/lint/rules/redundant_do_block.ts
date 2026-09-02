import type { Rule } from "../../../syntax/cursor.ts";
import {
  directRule,
  fieldRule,
  fieldRules,
  lineComments,
  trailingWhitespace,
} from "../syntax.ts";
import type { LintRule } from "../types.ts";

export const redundantDoBlock: LintRule = {
  name: "redundant-do-block",
  code: "BLOT_LINT_REDUNDANT_DO_BLOCK",
  severity: "hint",
  create(context) {
    return {
      concrete(rule) {
        if (rule.name !== "do_block") return;
        const statements = fieldRules(rule, "statements");
        if (statements.length !== 1) return;
        const statement = statements[0];
        if (statement === undefined) return;
        const result = directRule(statement, "result");
        if (result === null) return;
        const value = fieldRule(result, "value");
        if (value === null || value.name !== "value") return;

        const blockIndent = lineIndent(context.source, rule.span.start);
        const resultIndent = lineIndent(context.source, result.span.start);
        const returned = dedentValue(
          value,
          blockIndent,
          resultIndent,
          context.source,
        );
        const replacement = preserveBlockComments(
          rule,
          value,
          returned,
          blockIndent,
          resultIndent,
          context.source,
        ) + trailingWhitespace(context.source, rule.span);
        context.report({
          message:
            "This `do:` block only returns one expression; use that expression directly.",
          span: rule.span,
          fix: context.fix(
            rule.span,
            "Remove redundant `do:` block",
            replacement,
            "check-interface",
          ),
        });
      },
    };
  },
};

function preserveBlockComments(
  block: Rule,
  value: Rule,
  returned: string,
  indent: string,
  nestedIndent: string,
  source: string,
): string {
  const before = lineComments(source.slice(block.span.start, value.span.start));
  const after = lineComments(source.slice(value.span.end, block.span.end));
  if (before.length === 0 && after.length === 0) {
    return preserveGrouping(returned, value, indent, nestedIndent);
  }

  const lines = [
    ...before,
    ...returned.split("\n"),
    ...after,
  ].map((line) => `${nestedIndent}${line}`);
  return `(\n${lines.join("\n")}\n${indent})`;
}

function preserveGrouping(
  returned: string,
  value: Rule,
  indent: string,
  nestedIndent: string,
): string {
  if (isPrimaryValue(value)) return returned;
  if (!returned.includes("\n")) return `(${returned})`;

  const lines = returned.split("\n").map((line) => `${nestedIndent}${line}`);
  return `(\n${lines.join("\n")}\n${indent})`;
}

function isPrimaryValue(value: Rule): boolean {
  const expression = directRule(value, "expression");
  if (expression === null || fieldRules(expression, "rest").length > 0) {
    return false;
  }
  const operand = fieldRule(expression, "first");
  if (operand === null || fieldRules(operand, "prefixes").length > 0) {
    return false;
  }
  const postfix = fieldRule(operand, "value");
  if (
    postfix === null || fieldRules(postfix, "suffixes").length > 0 ||
    fieldRules(postfix, "arguments").length > 0
  ) return false;
  return fieldRule(postfix, "value") !== null;
}

function dedentValue(
  value: Rule,
  blockIndent: string,
  resultIndent: string,
  source: string,
): string {
  let removedIndent = "";
  if (resultIndent.startsWith(blockIndent)) {
    removedIndent = resultIndent.slice(blockIndent.length);
  }

  const lines = source.slice(value.span.start, value.span.end).trimEnd().split(
    "\n",
  );
  return lines.map((line, index) => {
    if (
      index > 0 && removedIndent.length > 0 &&
      line.startsWith(removedIndent)
    ) {
      return line.slice(removedIndent.length);
    }
    return line;
  }).join("\n");
}

function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, offset));
  if (match === null) return "";
  return match[0];
}
