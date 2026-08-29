import type { Decl, Expr, Span } from "../../../syntax/ast.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

export const terminalEffectForwarding: LintRule = {
  name: "terminal-effect-forwarding",
  code: "BLOT_LINT_TERMINAL_EFFECT_FORWARDING",
  severity: "hint",
  create(context) {
    return {
      module(path) {
        reportTerminalForwarding(
          path.node.declarations,
          path.node.result,
          context,
        );
      },
      expression(path) {
        if (path.node.tag !== "block") return;
        reportTerminalForwarding(
          path.node.declarations,
          path.node.result,
          context,
        );
      },
    };
  },
};

function reportTerminalForwarding(
  declarations: readonly Decl[],
  result: Expr,
  context: LintRuleContext,
): void {
  const declaration = declarations.at(-1);
  if (
    declaration === undefined || declaration.tag !== "binding" ||
    declaration.kind !== "effect" || declaration.pattern.tag !== "name" ||
    result.tag !== "var" || result.name !== declaration.pattern.name
  ) return;
  if (!context.hasConcreteOrigin(declaration, "sequencing")) return;
  if (
    !hasReadabilityFact(
      context,
      "direct-effect-computation",
      declaration.value.span,
    )
  ) {
    return;
  }

  const between = context.source.slice(declaration.span.end, result.span.start);
  if (!/^\s*return[ \t]+$/.test(between)) return;

  const replacement = `return ${context.sourceText(declaration.value)}`;
  const span = { start: declaration.span.start, end: result.span.end };
  context.report({
    message:
      "This terminal sequenced result is only returned; return the computation directly.",
    span,
    fix: context.fix(
      span,
      "Return computation directly",
      replacement,
      "check-interface",
    ),
  });
}

function hasReadabilityFact(
  context: LintRuleContext,
  kind: "direct-effect-computation",
  span: Span,
): boolean {
  return context.readability.some((fact) =>
    fact.kind === kind && sameSpan(fact.span, span)
  );
}

function sameSpan(left: Span, right: Span): boolean {
  return left.start === right.start && left.end === right.end;
}
