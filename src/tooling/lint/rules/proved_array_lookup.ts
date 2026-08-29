import type { Arm, Expr } from "../../../syntax/ast.ts";
import { calleePath } from "../syntax.ts";
import type { LintRule } from "../types.ts";

export const provedArrayLookup: LintRule = {
  name: "proved-array-lookup",
  code: "BLOT_LINT_PROVED_ARRAY_LOOKUP",
  severity: "hint",
  create(context) {
    return {
      expression(path) {
        const expression = path.node;
        if (expression.tag !== "case") return;
        if (!context.hasConcreteOrigin(expression, "case_expression")) return;
        if (
          context.concreteHasDescendant(
            expression,
            "case_expression",
            "case_guard",
          )
        ) return;
        const lookup = safeLookup(expression.target);
        if (lookup === null) return;
        const some = expression.arms.find((arm) => constructor(arm, "Some"));
        if (some === undefined || !returnsPayload(some)) return;
        if (!expression.arms.some((arm) => constructor(arm, "None"))) return;
        const fix = context.fix(
          expression.span,
          "Replace proved lookup with direct indexed access",
          `@array.get ${context.sourceText(lookup.array)} ${
            context.sourceText(lookup.index)
          }`,
          "check",
        );
        if (fix === null) return;
        context.report({
          message:
            "The compiler can prove this total lookup succeeds; use the direct indexed access.",
          span: expression.span,
          fix,
        });
      },
    };
  },
};

function safeLookup(
  expression: Expr,
): { readonly array: Expr; readonly index: Expr } | null {
  if (expression.tag !== "apply") return null;
  if (calleePath(expression.fn)?.join(".") !== "Array.get") return null;
  if (expression.arg.tag !== "tuple" || expression.arg.elements.length !== 2) {
    return null;
  }
  return {
    array: expression.arg.elements[0],
    index: expression.arg.elements[1],
  };
}

function constructor(arm: Arm, name: string): boolean {
  return arm.pattern.tag === "constructor" && arm.pattern.name === name;
}

function returnsPayload(arm: Arm): boolean {
  if (
    arm.pattern.tag !== "constructor" || arm.pattern.payload?.tag !== "name"
  ) return false;
  let body = arm.body;
  while (body.tag === "block" && body.declarations.length === 0) {
    body = body.result;
  }
  return body.tag === "var" && body.name === arm.pattern.payload.name;
}
