import type { Decl, Expr, Pattern } from "../../../syntax/ast.ts";
import { patternNames } from "../../../syntax/ast.ts";
import {
  declarationSequenceReads,
  expressionReads,
  spanKey,
} from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

export const unusedPatternName: LintRule = {
  name: "unused-pattern-name",
  code: "BLOT_LINT_UNUSED_PATTERN_NAME",
  severity: "hint",
  create(context) {
    const reported = new Set<string>();
    return {
      module(path) {
        if (path.node.parameter !== null) {
          reportUnusedNames(
            path.node.parameter,
            "module parameter",
            (name) =>
              declarationSequenceReads(
                path.node.declarations,
                path.node.result,
                new Set([name]),
              ),
            context,
            reported,
          );
        }
        reportUnusedBindingNames(
          path.node.declarations,
          path.node.result,
          context,
          reported,
        );
      },
      expression(path) {
        const expression = path.node;
        if (expression.tag === "block") {
          reportLoweredCaseNames(expression, context, reported);
          reportLoweredLoopNames(expression, context, reported);
          reportUnusedBindingNames(
            expression.declarations,
            expression.result,
            context,
            reported,
          );
          return;
        }
        if (expression.tag === "lambda" && expression.deferred !== true) {
          reportUnusedNames(
            expression.parameter,
            "parameter",
            (name) => expressionReads(expression.body, new Set([name])),
            context,
            reported,
          );
          return;
        }
        if (expression.tag !== "case") return;
        const loweredLoopCase =
          !context.hasConcreteOrigin(expression, "case_expression") &&
          context.hasConcreteOrigin(expression, "iteration");
        for (const arm of expression.arms) {
          let source: "case pattern" | "loop pattern" = "case pattern";
          let writableSpans: ReadonlySet<string> | null = null;
          if (loweredLoopCase) {
            source = "loop pattern";
            writableSpans = new Set(
              unqualifiedNames(arm.pattern).filter((name) =>
                context.hasConcreteOrigin(name, "application_primary") ||
                context.hasConcreteOrigin(name, "primary_expression") ||
                context.hasConcreteOrigin(name, "pattern_core")
              ).map((name) => spanKey(name.span)),
            );
          }
          reportUnusedNames(
            arm.pattern,
            source,
            (name) => expressionReads(arm.body, new Set([name])),
            context,
            reported,
            writableSpans,
          );
        }
      },
    };
  },
};

function reportUnusedBindingNames(
  declarations: readonly Decl[],
  result: Expr,
  context: LintRuleContext,
  reported: Set<string>,
): void {
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    if (declaration.tag !== "binding") continue;
    const sourceBinding = context.hasConcreteOrigin(declaration, "binding");
    const sourceSequencing = context.hasConcreteOrigin(
      declaration,
      "sequencing",
    );
    if (!sourceBinding && !sourceSequencing) continue;
    const names = unqualifiedNames(declaration.pattern);
    if (names.length === 0) continue;
    const reads = new Set(
      names.filter((name) =>
        declarationSequenceReads(
          declarations.slice(index + 1),
          result,
          new Set([name.name]),
        )
      ).map((name) => name.name),
    );
    const bindingIsUnread = !declarationSequenceReads(
      declarations.slice(index + 1),
      result,
      new Set(patternNames(declaration.pattern)),
    );
    if (
      bindingIsUnread && sourceBinding &&
      declaration.kind !== "effect" && declaration.tags.length === 0
    ) continue;
    if (
      sourceSequencing && declaration.pattern.tag === "name" &&
      reads.size === 0
    ) continue;
    let writableSpans: ReadonlySet<string> | null = null;
    if (sourceSequencing) {
      writableSpans = new Set(
        names.filter((name) =>
          context.hasConcreteOrigin(name, "primary_expression")
        ).map((name) => spanKey(name.span)),
      );
    }
    reportUnusedNames(
      declaration.pattern,
      "binding pattern",
      (name) => reads.has(name),
      context,
      reported,
      writableSpans,
    );
  }
}

function reportLoweredLoopNames(
  block: Extract<Expr, { readonly tag: "block" }>,
  context: LintRuleContext,
  reported: Set<string>,
): void {
  for (let index = 0; index < block.declarations.length; index += 1) {
    const declaration = block.declarations[index];
    if (
      declaration.tag !== "binding" ||
      context.hasConcreteOrigin(declaration, "binding") ||
      !context.hasConcreteOrigin(declaration, "iteration")
    ) continue;
    const writtenNames = unqualifiedNames(declaration.pattern).filter((name) =>
      context.hasConcreteOrigin(name, "primary_expression") ||
      context.hasConcreteOrigin(name, "pattern_core")
    );
    if (writtenNames.length === 0) continue;
    const writtenSpans = new Set(
      writtenNames.map((name) => spanKey(name.span)),
    );
    reportUnusedNames(
      declaration.pattern,
      "loop pattern",
      (name) =>
        declarationSequenceReads(
          block.declarations.slice(index + 1),
          block.result,
          new Set([name]),
        ),
      context,
      reported,
      writtenSpans,
    );
  }
}

function reportLoweredCaseNames(
  block: Extract<Expr, { readonly tag: "block" }>,
  context: LintRuleContext,
  reported: Set<string>,
): void {
  for (let index = 0; index < block.declarations.length; index += 1) {
    const declaration = block.declarations[index];
    if (!isLoweredCaseBinding(declaration, context)) continue;
    reportUnusedNames(
      declaration.pattern,
      "case pattern",
      (name) =>
        declarationSequenceReads(
          block.declarations.slice(index + 1),
          block.result,
          new Set([name]),
        ),
      context,
      reported,
    );
  }
}

function isLoweredCaseBinding(
  declaration: Decl,
  context: LintRuleContext,
): declaration is Extract<Decl, { readonly tag: "binding" }> {
  return declaration.tag === "binding" &&
    !context.hasConcreteOrigin(declaration, "binding") &&
    context.hasConcreteOrigin(declaration, "case_expression");
}

function reportUnusedNames(
  pattern: Pattern,
  source:
    | "module parameter"
    | "parameter"
    | "case pattern"
    | "binding pattern"
    | "loop pattern",
  reads: (name: string) => boolean,
  context: LintRuleContext,
  reported: Set<string>,
  writableSpans: ReadonlySet<string> | null = null,
): void {
  for (const name of unqualifiedNames(pattern)) {
    const key = spanKey(name.span);
    if (reported.has(key)) continue;
    if (
      writableSpans === null &&
      !context.hasConcreteOrigin(name, "pattern_core")
    ) continue;
    if (writableSpans !== null && !writableSpans.has(key)) continue;
    if (reads(name.name)) continue;
    reported.add(key);
    context.report({
      message:
        `The ${source} name \`${name.name}\` is never read; spell an intentionally ignored name as \`_\`.`,
      span: name.span,
      fix: context.fix(
        name.span,
        "Replace unused pattern name with `_`",
        "_",
        "check-interface",
      ),
    });
  }
}

function unqualifiedNames(
  pattern: Pattern,
): readonly Extract<Pattern, { readonly tag: "name" }>[] {
  switch (pattern.tag) {
    case "name":
      if (pattern.qualifier === "none") return [pattern];
      return [];
    case "tuple":
    case "array":
      return pattern.elements.flatMap(unqualifiedNames);
    case "constructor":
      if (pattern.payload === null) return [];
      return unqualifiedNames(pattern.payload);
    case "shape":
      return pattern.fields.flatMap((field) => unqualifiedNames(field.pattern));
    default:
      return [];
  }
}
