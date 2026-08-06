import type { Decl, Expr, Span } from "../../../syntax/ast.ts";
import { declarationSequenceReads } from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

export const unusedEffectResult: LintRule = {
  name: "unused-effect-result",
  code: "BLOT_LINT_UNUSED_EFFECT_RESULT",
  severity: "hint",
  create(context) {
    return {
      module(path) {
        reportUnusedResults(path.node.declarations, path.node.result, context);
      },
      expression(path) {
        if (path.node.tag !== "block") return;
        reportUnusedResults(
          path.node.declarations,
          path.node.result,
          context,
        );
      },
    };
  },
};

function reportUnusedResults(
  declarations: readonly Decl[],
  result: Expr,
  context: LintRuleContext,
): void {
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    if (declaration.tag !== "binding" || declaration.kind !== "effect") {
      continue;
    }
    if (!context.hasConcreteOrigin(declaration, "rebinding")) continue;
    if (
      declaration.pattern.tag !== "name" || declaration.pattern.name === "_"
    ) {
      continue;
    }
    if (
      declarationSequenceReads(
        declarations.slice(index + 1),
        result,
        new Set([declaration.pattern.name]),
      )
    ) continue;
    if (sourceReadsLater(declaration, declaration.pattern.name, context)) {
      continue;
    }
    const name = effectNameSpan(declaration, context);
    if (name === null) continue;
    context.report({
      message:
        `The result of this effect is never read; bind it to \`_\` to make the discard explicit.`,
      span: name,
      fix: context.fix(name, "Discard unused effect result explicitly", "_"),
    });
  }
}

function sourceReadsLater(
  declaration: Decl,
  name: string,
  context: LintRuleContext,
): boolean {
  const later = context.source.slice(declaration.span.end);
  return new RegExp(`\\b${name}\\b`).test(later);
}

function effectNameSpan(
  declaration: Extract<Decl, { readonly tag: "binding" }>,
  context: LintRuleContext,
): Span | null {
  const prefix = context.source.slice(
    declaration.span.start,
    declaration.value.span.start,
  );
  const match = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*<-/.exec(prefix);
  if (match === null) return null;
  return {
    start: declaration.span.start,
    end: declaration.span.start + match[1].length,
  };
}
