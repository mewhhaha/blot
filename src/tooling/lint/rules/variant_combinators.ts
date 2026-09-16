import type { Expr } from "../../../syntax/ast.ts";
import {
  appliedConstructor,
  readsDeferredParameter,
  sourceOperations,
} from "../operations.ts";
import type { AstNode, LintRule, LintRuleContext } from "../types.ts";

type Operation = "map" | "and_then" | "unwrap_or_else";

export const variantMap: LintRule = {
  name: "variant-map",
  code: "BLOT_LINT_VARIANT_MAP",
  severity: "hint",
  evidence: "syntax-only",
  create: (context) => ({
    expression: ({ node, ancestors }) =>
      inspect(node, "map", context, ancestors),
  }),
};

export const variantChaining: LintRule = {
  name: "variant-chaining",
  code: "BLOT_LINT_VARIANT_CHAINING",
  severity: "hint",
  evidence: "syntax-only",
  create: (context) => ({
    expression: ({ node, ancestors }) =>
      inspect(node, "and_then", context, ancestors),
  }),
};

export const variantFallback: LintRule = {
  name: "variant-fallback",
  code: "BLOT_LINT_VARIANT_FALLBACK",
  severity: "hint",
  evidence: "syntax-only",
  create: (context) => ({
    expression: ({ node, ancestors }) =>
      inspect(node, "unwrap_or_else", context, ancestors),
  }),
};

function inspect(
  expression: Expr,
  operation: Operation,
  context: LintRuleContext,
  ancestors: readonly AstNode[],
): void {
  if (
    expression.tag !== "case" || expression.arms.length !== 2 ||
    !context.hasConcreteOrigin(expression, "case_expression")
  ) return;
  const fact = sourceOperations(context, expression);
  if (fact === undefined) return;
  for (
    const [namespace, successTag, failureTag] of [["Option", "Some", "None"], [
      "Result",
      "Ok",
      "Error",
    ], ["Result", "Error", "Ok"]] as const
  ) {
    if (successTag === "Error" && operation !== "map") continue;
    const success = expression.arms.find((arm) =>
      arm.pattern.tag === "constructor" && arm.pattern.name === successTag
    );
    const failure = expression.arms.find((arm) =>
      arm.pattern.tag === "constructor" && arm.pattern.name === failureTag
    );
    if (
      success?.pattern.tag !== "constructor" ||
      failure?.pattern.tag !== "constructor" ||
      success.pattern.payload?.tag !== "name" ||
      success.pattern.payload.qualifier !== "none"
    ) continue;
    const value = success.pattern.payload.name;
    let member = namespace + "." + operation;
    if (successTag === "Error") member = "Result.map_error";
    if (!fact.operations.includes(member)) continue;
    let argument: string;
    if (operation === "unwrap_or_else") {
      if (
        success.body.tag !== "var" || success.body.name !== value ||
        failure.body.tag === "block"
      ) continue;
      if (namespace === "Option") {
        argument = "(" + context.sourceText(failure.body) + ")";
      } else {
        if (
          failure.pattern.payload?.tag !== "name" ||
          failure.pattern.payload.qualifier !== "none"
        ) continue;
        argument = "(fn " + failure.pattern.payload.name + " => " +
          context.sourceText(failure.body) + ")";
      }
    } else {
      if (namespace === "Option") {
        if (failure.body.tag !== "tag" || failure.body.name !== failureTag) {
          continue;
        }
      } else {
        const returned = appliedConstructor(failure.body, failureTag);
        if (
          failure.pattern.payload?.tag !== "name" ||
          failure.pattern.payload.qualifier !== "none" ||
          returned?.tag !== "var" ||
          returned.name !== failure.pattern.payload.name
        ) continue;
      }
      let mapped = success.body;
      if (operation === "map") {
        const payload = appliedConstructor(mapped, successTag);
        if (payload === null) continue;
        mapped = payload;
      } else if (appliedConstructor(mapped, successTag) !== null) continue;
      if (
        mapped.tag !== "apply" || mapped.fn.tag !== "var" ||
        mapped.fn.name === value ||
        mapped.arg.tag !== "var" || mapped.arg.name !== value
      ) continue;
      if (readsDeferredParameter(mapped.fn, ancestors)) continue;
      argument = context.sourceText(mapped.fn);
    }
    const replacement = member + " " + argument + " (" +
      context.sourceText(expression.target) + ")";
    context.report({
      message: "This simple variant match is the " + member + " operation.",
      span: expression.span,
      fix: context.fix(
        expression.span,
        "Use " + member,
        "(" + replacement + ")",
        "check-interface",
      ),
    });
  }
}
