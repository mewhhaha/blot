import type { Branch, Expr, Span } from "../../../syntax/ast.ts";
import type { Rule } from "../../../syntax/cursor.ts";
import { binaryCall, producedExpression } from "../syntax.ts";
import type { AstNode, LintRule, LintRuleContext } from "../types.ts";

interface EqualityBranch {
  readonly subject: string;
  readonly pattern: string;
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
    const comparison = equalityBranch(branch, context);
    if (comparison === null) return null;
    comparisons.push(comparison);
  }

  const first = comparisons[0];
  if (first === undefined) return null;
  const subject = first.subject;
  if (
    comparisons.some((comparison) => comparison.subject !== subject)
  ) return null;

  const fallbackText = returnedValue(flattened.fallback, context).text;
  if (
    comparisons.every((comparison) =>
      returnedValue(comparison.consequence, context).text === fallbackText
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

function equalityBranch(
  branch: Branch,
  context: LintRuleContext,
): EqualityBranch | null {
  const fact = context.simplifications.find((candidate) =>
    candidate.kind === "integer-equality" &&
    candidate.span.start === branch.condition.span.start &&
    candidate.span.end === branch.condition.span.end
  );
  if (fact?.kind !== "integer-equality") return null;
  const call = binaryCall(branch.condition);
  if (call === null) return null;
  let subject: Expr | null = null;
  if (
    call.left.span.start === fact.subject.start &&
    call.left.span.end === fact.subject.end
  ) {
    subject = call.left;
  }
  if (
    call.right.span.start === fact.subject.start &&
    call.right.span.end === fact.subject.end
  ) {
    subject = call.right;
  }
  if (subject === null || !isStableSubject(subject)) return null;
  let pattern: string;
  if (fact.pattern.kind === "integer-literal") {
    pattern = singleLine(
      context.source.slice(fact.pattern.span.start, fact.pattern.span.end),
    );
  } else {
    pattern = `^${fact.pattern.name}`;
  }
  return {
    subject: singleLine(context.sourceText(subject)),
    pattern,
    consequence: branch.consequence,
  };
}

function isStableSubject(expression: Expr): boolean {
  if (expression.tag === "var") return true;
  if (expression.tag === "field") return isStableSubject(expression.target);
  return false;
}

function equalityCase(
  chain: EqualityChain,
  context: LintRuleContext,
  indent: string,
): string {
  const armIndent = `${indent}  `;
  const arms = chain.branches.map((branch) =>
    caseArm(
      branch.pattern,
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
  const returned = returnedValue(expression, context);
  const bodyText = returned.text;
  if (body.tag !== "block" && !bodyText.includes("\n")) {
    return `${indent}${pattern} => ${bodyText}`;
  }
  return `${indent}${pattern} =>\n${
    valueLines(body, returned, context.source, `${indent}  `).join("\n")
  }`;
}

function valueLines(
  expression: Expr,
  returned: { readonly text: string; readonly span: Span },
  source: string,
  indent: string,
): readonly string[] {
  const originalIndent = lineIndent(source, returned.span.start);
  const lines = returned.text.split("\n");
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

function returnedValue(
  expression: Expr,
  context: LintRuleContext,
): { readonly text: string; readonly span: Span } {
  const produced = producedExpression(expression);
  const candidates: Rule[] = [];
  const visit = (rule: Rule): void => {
    if (
      rule.span.start > produced.span.start ||
      rule.span.end < produced.span.end
    ) return;
    if (rule.name === "result") {
      const value = rule.field("value");
      if (
        value !== undefined && value !== null && !Array.isArray(value) &&
        typeof value === "object" && "type" in value && value.type === "rule"
      ) {
        const candidate = value as Rule;
        if (
          candidate.span.start <= produced.span.start &&
          candidate.span.end >= produced.span.end
        ) candidates.push(candidate);
      }
    }
    for (const child of rule.children()) {
      if (child.type === "rule") visit(child);
    }
  };
  visit(context.cst);
  candidates.sort((left, right) =>
    left.span.end - left.span.start - (right.span.end - right.span.start)
  );
  const closest = candidates[0];
  if (closest === undefined) {
    throw new Error(
      `an equality chain branch at ${produced.span.start}..${produced.span.end} lost its returned value`,
    );
  }
  return {
    text: context.source.slice(closest.span.start, closest.span.end).trimEnd(),
    span: closest.span,
  };
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
