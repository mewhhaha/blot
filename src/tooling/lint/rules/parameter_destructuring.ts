import { patternNames } from "../../../syntax/ast.ts";
import { declarationSequenceReads, statementRemovalSpan } from "../syntax.ts";
import type { LintRule } from "../types.ts";

export const parameterDestructuring: LintRule = {
  name: "parameter-destructuring",
  code: "BLOT_LINT_PARAMETER_DESTRUCTURING",
  severity: "hint",
  create(context) {
    return {
      expression({ node }) {
        if (
          node.tag !== "lambda" || node.deferred ||
          node.parameter.tag !== "name" ||
          node.parameter.qualifier !== "none" || node.body.tag !== "block" ||
          !context.hasConcreteOrigin(node.body, "do_block")
        ) return;
        const [first, ...remaining] = node.body.declarations;
        const result = node.body.result;
        if (
          first === undefined || first.tag !== "binding" ||
          first.kind !== "let" ||
          first.tags.length !== 0 ||
          (first.pattern.tag !== "shape" && first.pattern.tag !== "tuple") ||
          first.value.tag !== "var" ||
          first.value.name !== node.parameter.name ||
          !context.hasConcreteOrigin(first, "binding")
        ) return;
        const names = patternNames(first.pattern);
        if (
          names.length === 0 ||
          declarationSequenceReads(
            remaining,
            node.body.result,
            new Set([node.parameter.name]),
          ) ||
          names.some((name) =>
            !declarationSequenceReads(remaining, result, new Set([name]))
          )
        ) return;
        const spelling = context.sourceText(first.pattern);
        if (/[!?&~]/.test(spelling)) return;
        context.report({
          message:
            "This function immediately destructures its parameter; put that pattern in the parameter.",
          span: first.span,
          fix: context.fixEdits({
            title: "Destructure in the function parameter",
            kind: "quickfix",
            validation: "check-interface",
            edits: [
              { span: node.parameter.span, replacement: spelling },
              {
                span: statementRemovalSpan(context.source, first.span),
                replacement: "",
              },
            ],
          }),
        });
      },
    };
  },
};
