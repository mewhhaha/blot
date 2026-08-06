import type { Decl, Expr } from "../../../syntax/ast.ts";
import { calleePath, declarationSequenceReads } from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

export const persistentArrayCopy: LintRule = {
  name: "persistent-array-copy",
  code: "BLOT_LINT_PERSISTENT_ARRAY_COPY",
  severity: "hint",
  create(context) {
    return {
      module(path) {
        reportCopies(path.node.declarations, path.node.result, context);
      },
      expression(path) {
        if (path.node.tag !== "block") return;
        reportCopies(path.node.declarations, path.node.result, context);
      },
    };
  },
};

function reportCopies(
  declarations: readonly Decl[],
  result: Expr,
  context: LintRuleContext,
): void {
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    if (declaration.tag !== "binding" || declaration.kind === "effect") {
      continue;
    }
    if (!context.hasConcreteOrigin(declaration, "binding")) continue;
    const update = persistentUpdate(declaration.value);
    if (update === null || update.array.tag !== "var") continue;
    if (
      !declarationSequenceReads(
        declarations.slice(index + 1),
        result,
        new Set([update.array.name]),
      )
    ) continue;
    context.report({
      message:
        `\`${update.array.name}\` remains live after this persistent array update, so the updated value cannot reuse its storage.`,
      span: update.call.span,
    });
  }
}

function persistentUpdate(
  expression: Expr,
): { readonly call: Expr; readonly array: Expr } | null {
  let call = expression;
  const arguments_: Expr[] = [];
  while (call.tag === "apply") {
    arguments_.unshift(call.arg);
    call = call.fn;
  }
  const path = calleePath(call)?.join(".");
  if (path !== "@array.push" && path !== "@array.set") return null;
  const array = arguments_[0];
  if (array === undefined) return null;
  return { call: expression, array };
}
