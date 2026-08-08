import type { Branch, Expr, Span } from "../../../syntax/ast.ts";
import { binaryCall, calleePath, producedExpression } from "../syntax.ts";
import type { AstNode, LintRule, LintRuleContext } from "../types.ts";

interface EqualityBranch {
  readonly subject: Expr;
  readonly pattern: Expr;
  readonly consequence: Expr;
}

interface EqualityChain {
  readonly subject: string;
  readonly branches: readonly EqualityBranch[];
  readonly fallback: Expr;
}

export const equalityIfChain: LintRule = {
  name: "equality-if-chain",
  code: "BLOT_LINT_IF_CHAIN",
  severity: "hint",
  create(context) {
    return {
      expression(path) {
        const expression = path.node;
        if (expression.tag !== "if") return;
        const terminalStatement = isTerminalStatement(
          expression,
          path.parent,
          context,
        );
        if (!terminalStatement) return;

        const chain = equalityChain(expression, context);
        if (chain === null) return;
        if (belongsToLargerEqualityChain(expression, path.parent, context)) {
          return;
        }

        let span = expression.span;
        let prefix = "";
        if (terminalStatement) {
          span = statementSpan(expression, context.source);
          prefix = "return ";
        }
        const indent = lineIndent(context.source, span.start);
        context.report({
          message:
            `Match ${chain.subject} once with an indented \`case ${chain.subject} of\` instead of repeating equality tests.`,
          span,
          fix: context.fix(
            span,
            "Replace equality chain with `case`",
            `${prefix}${equalityCase(chain, context, indent)}`,
          ),
        });
      },
    };
  },
};

export function prefersEqualityCase(
  expression: Extract<Expr, { readonly tag: "if" }>,
  context: LintRuleContext,
): boolean {
  return equalityChain(expression, context) !== null;
}

function equalityChain(
  expression: Extract<Expr, { readonly tag: "if" }>,
  context: LintRuleContext,
): EqualityChain | null {
  const flattened = flattenConditional(expression, context);
  if (flattened.branches.length < 2 || flattened.fallback === null) {
    return null;
  }
  const comparisons: EqualityBranch[] = [];
  for (const branch of flattened.branches) {
    const comparison = equalityBranch(branch);
    if (comparison === null) return null;
    comparisons.push(comparison);
  }

  const first = comparisons[0];
  if (first === undefined) return null;
  const subject = singleLine(context.sourceText(first.subject));
  if (
    comparisons.some((comparison) =>
      singleLine(context.sourceText(comparison.subject)) !== subject
    )
  ) return null;

  const fallbackText = context.sourceText(
    producedExpression(flattened.fallback),
  );
  if (
    comparisons.every((comparison) =>
      context.sourceText(producedExpression(comparison.consequence)) ===
        fallbackText
    )
  ) return null;
  return { subject, branches: comparisons, fallback: flattened.fallback };
}

function flattenConditional(
  expression: Extract<Expr, { readonly tag: "if" }>,
  context: LintRuleContext,
): { readonly branches: readonly Branch[]; readonly fallback: Expr | null } {
  const branches: Branch[] = [];
  let current = expression;
  while (true) {
    branches.push(...current.branches);
    if (current.fallback === null) return { branches, fallback: null };
    const fallback = producedExpression(current.fallback);
    if (fallback.tag !== "if" || !isSurfaceConditional(fallback, context)) {
      return { branches, fallback: current.fallback };
    }
    current = fallback;
  }
}

function equalityBranch(branch: Branch): EqualityBranch | null {
  const call = binaryCall(branch.condition);
  if (call === null || calleePath(call.callee)?.join(".") !== "Eq.eq") {
    return null;
  }
  const leftPattern = isCasePattern(call.left);
  const rightPattern = isCasePattern(call.right);
  if (leftPattern === rightPattern) return null;
  if (rightPattern) {
    return {
      subject: call.left,
      pattern: call.right,
      consequence: branch.consequence,
    };
  }
  return {
    subject: call.right,
    pattern: call.left,
    consequence: branch.consequence,
  };
}

function isCasePattern(expression: Expr): boolean {
  return expression.tag === "int" || expression.tag === "float" ||
    expression.tag === "text" || expression.tag === "tag" ||
    expression.tag === "unit";
}

function equalityCase(
  chain: EqualityChain,
  context: LintRuleContext,
  indent: string,
): string {
  const armIndent = `${indent}  `;
  const arms = chain.branches.map((branch) =>
    caseArm(
      singleLine(context.sourceText(branch.pattern)),
      branch.consequence,
      context,
      armIndent,
    )
  );
  arms.push(caseArm("_", chain.fallback, context, armIndent));
  return `case ${chain.subject} of\n${arms.join("\n")}`;
}

function caseArm(
  pattern: string,
  expression: Expr,
  context: LintRuleContext,
  indent: string,
): string {
  const body = producedExpression(expression);
  const bodyText = context.sourceText(body);
  if (body.tag !== "block" && !bodyText.includes("\n")) {
    return `${indent}${pattern} => ${bodyText}`;
  }
  return `${indent}${pattern} =>\n${
    valueLines(body, context.source, `${indent}  `).join("\n")
  }`;
}

function valueLines(
  expression: Expr,
  source: string,
  indent: string,
): readonly string[] {
  const text = source.slice(expression.span.start, expression.span.end)
    .trimEnd();
  const originalIndent = lineIndent(source, expression.span.start);
  const lines = text.split("\n");
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (line === undefined) continue;
    if (index > 0 && line.startsWith(originalIndent)) {
      line = line.slice(originalIndent.length);
    }
    let prefix = "";
    if (index === 0 && expression.tag !== "block") prefix = "return ";
    result.push(`${indent}${prefix}${line}`.trimEnd());
  }
  return result;
}

function belongsToLargerEqualityChain(
  expression: Extract<Expr, { readonly tag: "if" }>,
  parent: AstNode | null,
  context: LintRuleContext,
): boolean {
  if (parent === null || !("tag" in parent) || parent.tag !== "if") {
    return false;
  }
  if (parent.fallback === null) return false;
  if (producedExpression(parent.fallback) !== expression) return false;
  return equalityChain(parent, context) !== null;
}

function isTerminalStatement(
  expression: Extract<Expr, { readonly tag: "if" }>,
  parent: AstNode | null,
  context: LintRuleContext,
): boolean {
  if (
    !context.hasConcreteOrigin(
      expression,
      "conditional_statement_branches",
    )
  ) return false;
  if (parent === null) return false;
  if ("result" in parent && parent.result === expression) return true;
  if ("tag" in parent && parent.tag === "lambda") {
    return parent.body === expression;
  }
  return false;
}

function isSurfaceConditional(
  expression: Extract<Expr, { readonly tag: "if" }>,
  context: LintRuleContext,
): boolean {
  return context.hasConcreteOrigin(
    expression,
    "conditional_statement_branches",
  );
}

function statementSpan(
  expression: Extract<Expr, { readonly tag: "if" }>,
  source: string,
): Span {
  const lineStart = source.lastIndexOf("\n", expression.span.start - 1) + 1;
  const indent = lineIndent(source, expression.span.start);
  const start = lineStart + indent.length;
  if (!source.startsWith("if ", start)) {
    throw new Error("a terminal statement conditional lost its `if` keyword");
  }
  return { start, end: expression.span.end };
}

function singleLine(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, offset));
  if (match === null) return "";
  return match[0];
}
