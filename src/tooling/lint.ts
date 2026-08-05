import type { Diagnostic } from "../diagnostic.ts";
import type { Decl, Expr, Module } from "../syntax/ast.ts";

interface EqualityBranch {
  readonly subject: Expr;
}

export function lintModule(
  module: Module,
  source: string,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  lintDeclarations(module.declarations, source, diagnostics);
  lintExpression(module.result, source, diagnostics);
  return diagnostics;
}

function lintDeclarations(
  declarations: readonly Decl[],
  source: string,
  diagnostics: Diagnostic[],
): void {
  for (const declaration of declarations) {
    lintExpression(declaration.value, source, diagnostics);
    if (declaration.tag !== "binding") continue;
    for (const tag of declaration.tags) {
      lintExpression(tag.descriptor, source, diagnostics);
    }
  }
}

function lintExpression(
  expression: Expr,
  source: string,
  diagnostics: Diagnostic[],
): void {
  if (expression.tag === "if") {
    const redundant = lintRepeatedConsequences(expression, source, diagnostics);
    if (!redundant) lintEqualityChain(expression, source, diagnostics);
  }

  switch (expression.tag) {
    case "apply":
      lintExpression(expression.fn, source, diagnostics);
      lintExpression(expression.arg, source, diagnostics);
      return;
    case "field":
      lintExpression(expression.target, source, diagnostics);
      return;
    case "lambda":
      lintExpression(expression.body, source, diagnostics);
      return;
    case "rec":
      lintExpression(expression.lambda, source, diagnostics);
      return;
    case "comptime":
      lintExpression(expression.body, source, diagnostics);
      return;
    case "tuple":
      for (const element of expression.elements) {
        lintExpression(element, source, diagnostics);
      }
      return;
    case "array":
      for (const element of expression.elements) {
        lintExpression(element.value, source, diagnostics);
      }
      return;
    case "shape":
      for (const member of expression.members) {
        lintExpression(member.value, source, diagnostics);
      }
      return;
    case "if":
      for (const branch of expression.branches) {
        lintExpression(branch.condition, source, diagnostics);
        lintExpression(branch.consequence, source, diagnostics);
      }
      if (expression.fallback !== null) {
        lintExpression(expression.fallback, source, diagnostics);
      }
      return;
    case "case":
      lintExpression(expression.target, source, diagnostics);
      for (const arm of expression.arms) {
        lintExpression(arm.body, source, diagnostics);
      }
      return;
    case "block":
      lintDeclarations(expression.declarations, source, diagnostics);
      lintExpression(expression.result, source, diagnostics);
      return;
    default:
      return;
  }
}

function lintEqualityChain(
  expression: Extract<Expr, { readonly tag: "if" }>,
  source: string,
  diagnostics: Diagnostic[],
): void {
  if (expression.branches.length < 2 || expression.fallback === null) return;
  const comparisons = expression.branches.map((branch) =>
    equalityBranch(branch.condition)
  );
  if (comparisons.some((comparison) => comparison === null)) return;
  const first = comparisons[0];
  if (first === null) return;
  const subject = sourceText(first.subject, source);
  if (
    comparisons.some((comparison) =>
      comparison === null || sourceText(comparison.subject, source) !== subject
    )
  ) return;
  diagnostics.push({
    code: "BLOT_LINT_IF_CHAIN",
    message:
      `Match ${subject} once with an indented \`case ${subject} of\` instead of repeating equality tests.`,
    span: expression.span,
  });
}

function equalityBranch(
  condition: Expr,
): EqualityBranch | null {
  if (condition.tag !== "apply" || condition.fn.tag !== "apply") return null;
  if (!isEqualityFunction(condition.fn.fn)) return null;
  if (!isCasePattern(condition.arg)) return null;
  return { subject: condition.fn.arg };
}

function isEqualityFunction(expression: Expr): boolean {
  return expression.tag === "field" && expression.name === "eq" &&
    expression.target.tag === "var" && expression.target.name === "Eq";
}

function isCasePattern(expression: Expr): boolean {
  return expression.tag === "int" || expression.tag === "float" ||
    expression.tag === "text" || expression.tag === "tag" ||
    expression.tag === "unit";
}

function lintRepeatedConsequences(
  expression: Extract<Expr, { readonly tag: "if" }>,
  source: string,
  diagnostics: Diagnostic[],
): boolean {
  if (expression.fallback === null) return false;
  const fallback = sourceText(expression.fallback, source);
  if (
    expression.branches.some((branch) =>
      sourceText(branch.consequence, source) !== fallback
    )
  ) return false;
  diagnostics.push({
    code: "BLOT_LINT_REDUNDANT_IF",
    message:
      "Every branch produces the same expression; remove the conditional.",
    span: expression.span,
  });
  return true;
}

function sourceText(expression: Expr, source: string): string {
  return source.slice(expression.span.start, expression.span.end).trim();
}
