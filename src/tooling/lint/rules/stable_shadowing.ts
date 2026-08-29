import type { Decl, Expr, Span } from "../../../syntax/ast.ts";
import type { Rule } from "../../../syntax/cursor.ts";
import {
  declarationNames,
  declarationSequenceReads,
  spanKey,
} from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

export const stableShadowing: LintRule = {
  name: "stable-shadowing",
  code: "BLOT_LINT_STABLE_SHADOWING",
  severity: "hint",
  create(context) {
    const nestedControlBindings = new Set<string>();
    collectNestedControlBindings(context.cst, false, nestedControlBindings);
    return {
      module(path) {
        reportStableShadows(
          path.node.declarations,
          path.node.result,
          context,
          nestedControlBindings,
        );
      },
      expression(path) {
        if (path.node.tag !== "block") return;
        reportStableShadows(
          path.node.declarations,
          path.node.result,
          context,
          nestedControlBindings,
        );
      },
    };
  },
};

function reportStableShadows(
  declarations: readonly Decl[],
  result: Expr,
  context: LintRuleContext,
  nestedControlBindings: ReadonlySet<string>,
): void {
  const introduced = new Set<string>();
  const previousDeclarations = new Map<string, number>();
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    if (
      declaration.tag === "binding" && declaration.kind === "let" &&
      declaration.tags.length === 0 && declaration.pattern.tag === "name" &&
      declaration.pattern.qualifier === "none" &&
      declaration.value.tag !== "rec" &&
      introduced.has(declaration.pattern.name) &&
      !previousBindingNameIsUnread(
        declaration.pattern.name,
        previousDeclarations.get(declaration.pattern.name),
        declarations,
        result,
        context,
      ) &&
      !nestedControlBindings.has(spanKey(declaration.span)) &&
      context.hasConcreteOrigin(declaration, "binding") &&
      hasStableShadowFact(declaration, context)
    ) {
      reportStableShadow(declaration, context);
    }
    for (const name of declarationNames(declaration)) {
      introduced.add(name);
      previousDeclarations.set(name, index);
    }
  }
}

function previousBindingNameIsUnread(
  name: string,
  previousIndex: number | undefined,
  declarations: readonly Decl[],
  result: Expr,
  context: LintRuleContext,
): boolean {
  if (previousIndex === undefined) return false;
  const previous = declarations[previousIndex];
  if (
    previous === undefined || previous.tag !== "binding" ||
    (!context.hasConcreteOrigin(previous, "binding") &&
      !context.hasConcreteOrigin(previous, "sequencing"))
  ) return false;
  const names = declarationNames(previous);
  if (!names.includes(name)) return false;
  return !declarationSequenceReads(
    declarations.slice(previousIndex + 1),
    result,
    new Set([name]),
  );
}

function hasStableShadowFact(
  declaration: Extract<Decl, { readonly tag: "binding" }>,
  context: LintRuleContext,
): boolean {
  if (declaration.pattern.tag !== "name") return false;
  const name = declaration.pattern.name;
  return context.readability.some((fact) =>
    fact.kind === "stable-shadow" &&
    fact.name === name &&
    sameSpan(fact.span, declaration.value.span)
  );
}

function reportStableShadow(
  declaration: Extract<Decl, { readonly tag: "binding" }>,
  context: LintRuleContext,
): void {
  if (declaration.pattern.tag !== "name") return;
  const header = context.source.slice(
    declaration.span.start,
    declaration.value.span.start,
  );
  const equals = header.lastIndexOf("=");
  if (equals < 0) return;
  const afterEquals = header.slice(equals + 1);
  const replacement = `${declaration.pattern.name} :=${afterEquals}`;
  const span = {
    start: declaration.span.start,
    end: declaration.value.span.start,
  };
  context.report({
    message:
      `\`${declaration.pattern.name}\` keeps its stable type here; use \`:=\` to make that continuity explicit.`,
    span: declaration.span,
    fix: context.fix(
      span,
      `Rebind \`${declaration.pattern.name}\` with \`:=\``,
      replacement,
      "check-interface",
    ),
  });
}

function collectNestedControlBindings(
  rule: Rule,
  nestedControl: boolean,
  found: Set<string>,
): void {
  const insideControl = nestedControl || rule.name === "iteration" ||
    rule.name === "conditional_statement";
  if (insideControl && rule.name === "binding") {
    found.add(spanKey(rule.span));
  }
  for (const child of rule.children()) {
    if (child.type === "rule") {
      collectNestedControlBindings(child, insideControl, found);
    }
  }
}

function sameSpan(left: Span, right: Span): boolean {
  return left.start === right.start && left.end === right.end;
}
