import { patternNames } from "../../../syntax/ast.ts";
import {
  readsDeferredParameter,
  sourceIndent,
  sourceOperations,
} from "../operations.ts";
import { expressionReads } from "../syntax.ts";
import type { LintRule } from "../types.ts";

export const accumulatorFold: LintRule = {
  name: "accumulator-fold",
  code: "BLOT_LINT_ACCUMULATOR_FOLD",
  severity: "hint",
  create(context) {
    return {
      expression({ node, ancestors }) {
        if (
          node.tag !== "apply" || node.arg.tag !== "tuple" ||
          node.arg.elements.length !== 3
        ) return;
        const fact = sourceOperations(context, node);
        if (
          fact?.callee !== "fold" || !fact.operations.includes("Iter.items")
        ) return;
        const [values, initial, visit] = node.arg.elements;
        if (values.tag !== "var" || readsDeferredParameter(values, ancestors)) {
          return;
        }
        if (
          visit.tag !== "lambda" || visit.deferred ||
          visit.parameter.tag !== "tuple" ||
          visit.parameter.elements.length !== 2 || visit.body.tag === "block"
        ) return;
        const [state, element] = visit.parameter.elements;
        if (
          state.tag !== "name" || state.qualifier !== "none" ||
          element.tag !== "name" ||
          element.qualifier !== "none" || state.name === element.name
        ) return;
        const names = new Set(patternNames(visit.parameter));
        if (
          expressionReads(values, names) ||
          expressionReads(initial, new Set([state.name]))
        ) return;
        const indent = sourceIndent(context.source, node.span.start);
        const inside = indent + "  ";
        const replacement = "do:\n" + inside + "let " + state.name + " = " +
          context.sourceText(initial) +
          "\n" + inside + "for " + element.name + " in Iter.items (" +
          context.sourceText(values) + "):\n" +
          inside + "  " + state.name + " := " + context.sourceText(visit.body) +
          "\n" + inside + "return " + state.name;
        context.report({
          message:
            "This fold threads one named accumulator through an ordinary traversal.",
          span: node.span,
          fix: context.fix(
            node.span,
            "Write the accumulator fold as a loop",
            replacement,
            "check-interface",
            "refactor.rewrite",
          ),
        });
      },
    };
  },
};
