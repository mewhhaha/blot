import type { Decl, Expr } from "../../../syntax/ast.ts";
import { patternNames } from "../../../syntax/ast.ts";
import { declarationNames } from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

export const specializationCount: LintRule = {
  name: "specialization-count",
  code: "BLOT_LINT_SPECIALIZATION_COUNT",
  severity: "hint",
  create(context) {
    return {
      module(path) {
        reportSpecializations(
          path.node.declarations,
          path.node.result,
          context,
        );
      },
      expression(path) {
        if (path.node.tag !== "block") return;
        reportSpecializations(
          path.node.declarations,
          path.node.result,
          context,
        );
      },
    };
  },
};

function reportSpecializations(
  declarations: readonly Decl[],
  result: Expr,
  context: LintRuleContext,
): void {
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    if (declaration.tag !== "binding" || declaration.pattern.tag !== "name") {
      continue;
    }
    if (!context.hasConcreteOrigin(declaration, "binding")) continue;
    const lambda = declaredLambda(declaration.value);
    if (lambda === null || patternNames(lambda.parameter).length === 0) {
      continue;
    }
    const shapes = new Set<string>();
    let visible = true;
    for (const following of declarations.slice(index + 1)) {
      collectCalls(following.value, declaration.pattern.name, shapes);
      if (declarationNames(following).includes(declaration.pattern.name)) {
        visible = false;
        break;
      }
    }
    if (visible) collectCalls(result, declaration.pattern.name, shapes);
    if (shapes.size < 2) continue;
    context.report({
      message:
        `\`${declaration.pattern.name}\` is called with ${shapes.size} distinct record shapes, exposing up to that many specializations.`,
      span: declaration.pattern.span,
    });
  }
}

function declaredLambda(
  expression: Expr,
): Extract<Expr, { readonly tag: "lambda" }> | null {
  if (expression.tag === "lambda") return expression;
  if (expression.tag === "rec" && expression.lambda.tag === "lambda") {
    return expression.lambda;
  }
  return null;
}

function collectCalls(
  expression: Expr,
  name: string,
  shapes: Set<string>,
): void {
  if (
    expression.tag === "apply" && expression.fn.tag === "var" &&
    expression.fn.name === name
  ) {
    const shape = shapeKey(expression.arg);
    if (shape !== null) shapes.add(shape);
  }
  switch (expression.tag) {
    case "apply":
      collectCalls(expression.fn, name, shapes);
      collectCalls(expression.arg, name, shapes);
      return;
    case "field":
      collectCalls(expression.target, name, shapes);
      return;
    case "lambda":
      if (!patternNames(expression.parameter).includes(name)) {
        collectCalls(expression.body, name, shapes);
      }
      return;
    case "rec":
      collectCalls(expression.lambda, name, shapes);
      return;
    case "comptime":
      collectCalls(expression.body, name, shapes);
      return;
    case "tuple":
      for (const element of expression.elements) {
        collectCalls(element, name, shapes);
      }
      return;
    case "array":
      for (const element of expression.elements) {
        collectCalls(element.value, name, shapes);
      }
      return;
    case "shape":
      for (const member of expression.members) {
        collectCalls(member.value, name, shapes);
      }
      return;
    case "if":
      for (const branch of expression.branches) {
        collectCalls(branch.condition, name, shapes);
        collectCalls(branch.consequence, name, shapes);
      }
      if (expression.fallback !== null) {
        collectCalls(expression.fallback, name, shapes);
      }
      return;
    case "case":
      collectCalls(expression.target, name, shapes);
      for (const arm of expression.arms) {
        if (!patternNames(arm.pattern).includes(name)) {
          collectCalls(arm.body, name, shapes);
        }
      }
      return;
    case "block":
      for (const declaration of expression.declarations) {
        collectCalls(declaration.value, name, shapes);
        if (declarationNames(declaration).includes(name)) return;
      }
      collectCalls(expression.result, name, shapes);
      return;
    default:
      return;
  }
}

function shapeKey(expression: Expr): string | null {
  if (expression.tag !== "shape") return null;
  return expression.members.map((member) =>
    member.tag === "field" ? member.name : "..."
  ).sort().join(",");
}
