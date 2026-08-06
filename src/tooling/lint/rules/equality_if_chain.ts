import type { Expr } from "../../../syntax/ast.ts";
import { binaryCall, calleePath, producedExpression } from "../syntax.ts";
import type { LintRule } from "../types.ts";

interface EqualityBranch {
  readonly subject: Expr;
  readonly pattern: Expr;
}

export const equalityIfChain: LintRule = {
  name: "equality-if-chain",
  code: "BLOT_LINT_IF_CHAIN",
  severity: "hint",
  create(context) {
    return {
      expression(path) {
        const expression = path.node;
        if (
          expression.tag !== "if" || !context.isValueConditional(expression)
        ) return;
        if (expression.branches.length < 2 || expression.fallback === null) {
          return;
        }
        const fallbackText = context.sourceText(
          producedExpression(expression.fallback),
        );
        if (
          expression.branches.every((branch) =>
            context.sourceText(producedExpression(branch.consequence)) ===
              fallbackText
          )
        ) return;
        const comparisons = expression.branches.map((branch) =>
          equalityBranch(branch.condition)
        );
        if (comparisons.some((comparison) => comparison === null)) return;
        const first = comparisons[0];
        if (first === null || first === undefined) return;
        const subject = context.sourceText(first.subject);
        if (
          comparisons.some((comparison) =>
            comparison === null ||
            context.sourceText(comparison.subject) !== subject
          )
        ) return;
        context.report({
          message:
            `Match ${subject} once with an indented \`case ${subject} of\` instead of repeating equality tests.`,
          span: expression.span,
          fix: context.fix(
            expression.span,
            "Replace equality chain with `case`",
            equalityCase(
              expression,
              comparisons,
              subject,
              context.sourceText,
              lineIndent(context.source, expression.span.start),
            ),
          ),
        });
      },
    };
  },
};

function equalityBranch(condition: Expr): EqualityBranch | null {
  const call = binaryCall(condition);
  if (call === null || calleePath(call.callee)?.join(".") !== "Eq.eq") {
    return null;
  }
  if (!isCasePattern(call.right)) return null;
  return { subject: call.left, pattern: call.right };
}

function isCasePattern(expression: Expr): boolean {
  return expression.tag === "int" || expression.tag === "float" ||
    expression.tag === "text" || expression.tag === "tag" ||
    expression.tag === "unit";
}

function equalityCase(
  expression: Extract<Expr, { readonly tag: "if" }>,
  comparisons: readonly (EqualityBranch | null)[],
  subject: string,
  sourceText: (node: { readonly span: Expr["span"] }) => string,
  indent: string,
): string {
  const armIndent = `${indent}  `;
  const arms = expression.branches.map((branch, index) => {
    const comparison = comparisons[index];
    if (comparison === null || comparison === undefined) {
      throw new Error("a checked equality chain lost its comparison");
    }
    return `${armIndent}${sourceText(comparison.pattern)} => ${
      sourceText(producedExpression(branch.consequence))
    }`;
  });
  const fallback = expression.fallback;
  if (fallback === null) {
    throw new Error("a checked equality chain lost its fallback");
  }
  arms.push(`${armIndent}_ => ${sourceText(producedExpression(fallback))}`);
  return `case ${subject} of\n${arms.join("\n")}`;
}

function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart, offset))?.[0] ?? "";
}
