import type { Decl, Expr } from "../../../syntax/ast.ts";
import { patternNames } from "../../../syntax/ast.ts";
import { declarationSequenceReads, sourceEditSpan } from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

export const unusedBinding: LintRule = {
  name: "unused-binding",
  code: "BLOT_LINT_UNUSED_BINDING",
  severity: "warning",
  create(context) {
    return {
      module(path) {
        reportUnused(path.node.declarations, path.node.result, context);
      },
      expression(path) {
        if (path.node.tag !== "block") return;
        reportUnused(path.node.declarations, path.node.result, context);
      },
    };
  },
};

function reportUnused(
  declarations: readonly Decl[],
  result: Expr,
  context: LintRuleContext,
): void {
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    if (declaration.tag !== "binding") continue;
    if (!context.hasConcreteOrigin(declaration, "binding")) continue;
    if (declaration.tags.length > 0 || declaration.kind === "effect") continue;
    const names = patternNames(declaration.pattern);
    if (names.length === 0) continue;
    if (
      declarationSequenceReads(
        declarations.slice(index + 1),
        result,
        new Set(names),
      )
    ) continue;
    const editSpan = sourceEditSpan(context.source, declaration.span);
    context.report({
      message: names.length === 1
        ? `\`${sourceName(names[0])}\` is never read; remove its pure binding.`
        : "None of the names introduced by this pure binding are read; remove it.",
      span: declaration.span,
      fix: context.fix(editSpan, "Remove unused binding", ""),
    });
  }
}

function sourceName(name: string): string {
  const fresh = name.lastIndexOf("$");
  if (fresh < 0) return name;
  return name.slice(0, fresh);
}
