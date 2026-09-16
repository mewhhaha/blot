import type { Decl, Expr } from "../../../syntax/ast.ts";
import { readsDeferredParameter } from "../operations.ts";
import { declarationSequenceReads, sourceEditSpan } from "../syntax.ts";
import type { AstNode, LintRule, LintRuleContext } from "../types.ts";

export const projectionDestructuring: LintRule = {
  name: "projection-destructuring",
  code: "BLOT_LINT_PROJECTION_DESTRUCTURING",
  severity: "hint",
  evidence: "syntax-only",
  create(context) {
    return {
      module: ({ node }) =>
        inspect(node.declarations, node.result, context, []),
      expression({ node, ancestors }) {
        if (node.tag === "block") {
          inspect(node.declarations, node.result, context, ancestors);
        }
      },
    };
  },
};

function inspect(
  declarations: readonly Decl[],
  result: Expr,
  context: LintRuleContext,
  ancestors: readonly AstNode[],
): void {
  for (let index = 0; index + 1 < declarations.length; index += 1) {
    if (index > 0 && declarations[index - 1].tag === "signature") continue;
    const first = projection(declarations[index], context, ancestors);
    const second = projection(declarations[index + 1], context, ancestors);
    if (
      first === null || second === null || first.source !== second.source ||
      first.field === second.field || first.name === second.name ||
      first.name === first.source || second.name === first.source
    ) continue;
    const later = declarations.slice(index + 2);
    if (
      !declarationSequenceReads(later, result, new Set([first.name])) ||
      !declarationSequenceReads(later, result, new Set([second.name]))
    ) continue;
    const members = [first, second].map((field) =>
      "." + field.field + " = " + field.name + ";"
    );
    const span = {
      start: declarations[index].span.start,
      end: sourceEditSpan(context.source, declarations[index + 1].span).end,
    };
    context.report({
      message:
        "These adjacent bindings project the same record; destructure it once.",
      span,
      fix: context.fix(
        span,
        "Destructure adjacent record fields",
        "let { " + members.join(" ") + " } = " + first.source + "\n",
        "check-interface",
      ),
    });
    index += 1;
  }
}

function projection(
  declaration: Decl,
  context: LintRuleContext,
  ancestors: readonly AstNode[],
): { name: string; field: string; source: string } | null {
  if (
    declaration.tag !== "binding" || declaration.kind !== "let" ||
    declaration.tags.length !== 0 || declaration.pattern.tag !== "name" ||
    declaration.pattern.qualifier !== "none" ||
    declaration.value.tag !== "field" ||
    declaration.value.target.tag !== "var" ||
    readsDeferredParameter(declaration.value, ancestors) ||
    !context.hasConcreteOrigin(declaration, "binding")
  ) return null;
  return {
    name: declaration.pattern.name,
    field: declaration.value.name,
    source: declaration.value.target.name,
  };
}
