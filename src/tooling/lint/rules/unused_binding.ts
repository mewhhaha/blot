import type { Decl, Expr } from "../../../syntax/ast.ts";
import { patternNames } from "../../../syntax/ast.ts";
import { readsDeferredParameter } from "../operations.ts";
import { declarationSequenceReads, sourceEditSpan } from "../syntax.ts";
import type { AstNode, LintRule, LintRuleContext } from "../types.ts";

export const unusedBinding: LintRule = {
  name: "unused-binding",
  code: "BLOT_LINT_UNUSED_BINDING",
  severity: "warning",
  evidence: "syntax-only",
  create(context) {
    return {
      module(path) {
        reportUnused(
          path.node.declarations,
          path.node.result,
          path.ancestors,
          context,
        );
      },
      expression(path) {
        if (path.node.tag !== "block") return;
        reportUnused(
          path.node.declarations,
          path.node.result,
          path.ancestors,
          context,
        );
      },
    };
  },
};

function reportUnused(
  declarations: readonly Decl[],
  result: Expr,
  ancestors: readonly AstNode[],
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
    if (!isRemovableValue(declaration.value, ancestors)) continue;
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

// Removing a binding also removes its value, so removal is sound only for
// values that cannot perform an effect when evaluated. Calls are never
// pure: even a const-bound call can register an effect, attach metadata,
// or force a deferred argument.
function isRemovableValue(
  value: Expr,
  ancestors: readonly AstNode[],
): boolean {
  switch (value.tag) {
    case "int":
    case "float":
    case "text":
    case "unit":
    case "tag":
    case "intrinsic":
    case "lambda":
    case "rec":
      return true;
    case "var":
      return !readsDeferredParameter(value, ancestors);
    case "field":
      return isRemovableValue(value.target, ancestors);
    case "array":
      return value.elements.every((element) =>
        isRemovableValue(element.value, ancestors)
      );
    case "tuple":
      return value.elements.every((element) =>
        isRemovableValue(element, ancestors)
      );
    case "shape":
      return value.members.every((member) => {
        if (
          member.tag === "computed" && !isRemovableValue(member.name, ancestors)
        ) {
          return false;
        }
        return isRemovableValue(member.value, ancestors);
      });
    case "apply":
      return isPureConstructorApplication(value, ancestors);
    case "if":
    case "case":
    case "block":
      return false;
  }
}

// A constructor applied to pure payloads builds a value and nothing else.
// Every other call shape may run user code or a side-effecting primitive.
function isPureConstructorApplication(
  value: Extract<Expr, { readonly tag: "apply" }>,
  ancestors: readonly AstNode[],
): boolean {
  const args: Expr[] = [value.arg];
  let fn = value.fn;
  while (fn.tag === "apply") {
    args.push(fn.arg);
    fn = fn.fn;
  }
  if (fn.tag !== "tag") return false;
  return args.every((arg) => isRemovableValue(arg, ancestors));
}
