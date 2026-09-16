import type { Decl, Expr } from "../../../syntax/ast.ts";
import { readsDeferredParameter, sourceOperations } from "../operations.ts";
import { declarationSequenceReads, sourceEditSpan } from "../syntax.ts";
import type { AstNode, LintRule, LintRuleContext } from "../types.ts";

export const complementaryFilters: LintRule = {
  name: "complementary-filters",
  code: "BLOT_LINT_COMPLEMENTARY_FILTERS",
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

function filter(
  expression: Expr,
  context: LintRuleContext,
): readonly [Expr, Expr] | null {
  if (
    expression.tag !== "apply" || expression.arg.tag !== "tuple" ||
    expression.arg.elements.length !== 2
  ) return null;
  const callee = sourceOperations(context, expression)?.callee;
  if (callee !== "filter" && callee !== "Array.filter") return null;
  return [expression.arg.elements[0], expression.arg.elements[1]];
}

function inspect(
  declarations: readonly Decl[],
  result: Expr,
  context: LintRuleContext,
  ancestors: readonly AstNode[],
): void {
  for (let index = 1; index + 1 < declarations.length; index += 1) {
    const first = declarations[index];
    const second = declarations[index + 1];
    if (
      first.tag !== "binding" || second.tag !== "binding" ||
      first.kind !== "let" || second.kind !== "let" ||
      first.tags.length !== 0 || second.tags.length !== 0 ||
      first.pattern.tag !== "name" || second.pattern.tag !== "name" ||
      first.pattern.qualifier !== "none" ||
      second.pattern.qualifier !== "none" ||
      first.pattern.name === second.pattern.name
    ) continue;
    const accepted = filter(first.value, context);
    const rejected = filter(second.value, context);
    if (
      accepted === null || rejected === null || accepted[0].tag !== "var" ||
      rejected[0].tag !== "var" ||
      accepted[0].name !== rejected[0].name || accepted[1].tag !== "var" ||
      rejected[1].tag !== "lambda" ||
      readsDeferredParameter(accepted[0], ancestors)
    ) continue;
    const predicateName = accepted[1].name;
    const negative = rejected[1];
    if (
      negative.deferred || negative.parameter.tag !== "name" ||
      negative.parameter.qualifier !== "none" ||
      negative.body.tag !== "apply"
    ) continue;
    const negation = sourceOperations(context, negative.body)?.callee;
    if (negation !== "not" && negation !== "Logic.not") continue;
    const tested = negative.body.arg;
    if (
      tested.tag !== "apply" || tested.fn.tag !== "var" ||
      tested.fn.name !== predicateName ||
      tested.arg.tag !== "var" || tested.arg.name !== negative.parameter.name
    ) continue;
    const predicate = declarations.slice(0, index).toReversed().find((
      declaration,
    ) =>
      declaration.tag === "binding" && declaration.pattern.tag === "name" &&
      declaration.pattern.name === predicateName
    );
    if (
      predicate?.tag !== "binding" ||
      readsDeferredParameter(predicate.value, ancestors) ||
      sourceOperations(context, predicate.value)?.totalPredicate !== true ||
      !sourceOperations(context, first.value)?.operations.includes("partition")
    ) continue;
    const later = declarations.slice(index + 2);
    if (
      !declarationSequenceReads(later, result, new Set([first.pattern.name])) ||
      !declarationSequenceReads(later, result, new Set([second.pattern.name]))
    ) continue;
    const span = {
      start: first.span.start,
      end: sourceEditSpan(context.source, second.span).end,
    };
    context.report({
      message:
        "Both complementary filters use a proved total predicate; partition the array in one pass.",
      span,
      fix: context.fix(
        span,
        "Partition with the predicate once",
        "let (" + first.pattern.name + ", " + second.pattern.name +
          ") = partition (" + accepted[0].name + ", " + predicateName + ")\n",
        "check-interface",
        "refactor.rewrite",
      ),
    });
  }
}
