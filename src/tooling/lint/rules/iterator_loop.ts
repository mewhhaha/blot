import type { Decl, Expr } from "../../../syntax/ast.ts";
import { readsDeferredParameter, sourceIndent } from "../operations.ts";
import { expressionReads } from "../syntax.ts";
import type { AstNode, LintRule, LintRuleContext } from "../types.ts";

export const iteratorLoop: LintRule = {
  name: "iterator-loop",
  code: "BLOT_LINT_ITERATOR_LOOP",
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
  const binding = declarations.at(-1);
  if (
    binding?.tag !== "binding" || binding.kind !== "let" ||
    binding.tags.length !== 0 ||
    binding.pattern.tag !== "name" || binding.pattern.qualifier !== "none" ||
    binding.value.tag !== "rec" || binding.value.lambda.tag !== "lambda" ||
    declarations.at(-2)?.tag === "signature" ||
    !context.hasConcreteOrigin(binding, "binding")
  ) return;
  const lambda = binding.value.lambda;
  if (
    lambda.deferred || lambda.parameter.tag !== "tuple" ||
    lambda.parameter.elements.length !== 2 || lambda.body.tag !== "case"
  ) return;
  const [state, accumulator] = lambda.parameter.elements;
  if (
    state.tag !== "name" || state.qualifier !== "none" ||
    accumulator.tag !== "name" || accumulator.qualifier !== "none"
  ) return;
  const match = lambda.body;
  if (
    match.target.tag !== "apply" || match.target.fn.tag !== "field" ||
    match.target.fn.name !== "step" ||
    match.target.fn.target.tag !== "var" || match.target.arg.tag !== "var" ||
    readsDeferredParameter(match.target.fn.target, ancestors) ||
    match.target.arg.name !== state.name ||
    match.arms.length !== 2
  ) return;
  const iterator = match.target.fn.target.name;
  if (iterator === accumulator.name || iterator === state.name) return;
  const done = match.arms.find((arm) =>
    arm.pattern.tag === "constructor" && arm.pattern.name === "None"
  );
  const next = match.arms.find((arm) =>
    arm.pattern.tag === "constructor" && arm.pattern.name === "Some"
  );
  if (
    done?.body.tag !== "var" || done.body.name !== accumulator.name ||
    next?.pattern.tag !== "constructor" ||
    next.pattern.payload?.tag !== "tuple" ||
    next.pattern.payload.elements.length !== 2
  ) return;
  const [element, successor] = next.pattern.payload.elements;
  if (
    element.tag !== "name" || element.qualifier !== "none" ||
    successor.tag !== "name" || successor.qualifier !== "none" ||
    element.name === accumulator.name || element.name === iterator
  ) return;
  if (
    next.body.tag !== "apply" || next.body.fn.tag !== "var" ||
    next.body.fn.name !== binding.pattern.name ||
    next.body.arg.tag !== "tuple" || next.body.arg.elements.length !== 2
  ) return;
  const [nextState, update] = next.body.arg.elements;
  if (
    nextState.tag !== "var" || nextState.name !== successor.name ||
    expressionReads(
      update,
      new Set([state.name, successor.name, binding.pattern.name]),
    ) ||
    result.tag !== "apply" || result.fn.tag !== "var" ||
    result.fn.name !== binding.pattern.name ||
    result.arg.tag !== "tuple" || result.arg.elements.length !== 2
  ) return;
  const [initialState, initial] = result.arg.elements;
  if (
    initialState.tag !== "field" || initialState.name !== "state" ||
    initialState.target.tag !== "var" || initialState.target.name !== iterator
  ) return;
  const indent = sourceIndent(context.source, binding.span.start);
  const replacement = "let " + accumulator.name + " = " +
    context.sourceText(initial) +
    "\n" + indent + "for " + element.name + " in " + iterator + ":\n" + indent +
    "  " +
    accumulator.name + " := " + context.sourceText(update) + "\n" + indent +
    "return " + accumulator.name;
  const span = { start: binding.span.start, end: result.span.end };
  context.report({
    message:
      "This recursive function only consumes the iterator and threads its accumulator.",
    span: binding.span,
    fix: context.fix(
      span,
      "Consume the iterator with a loop",
      replacement,
      "check-interface",
      "refactor.rewrite",
    ),
  });
}
