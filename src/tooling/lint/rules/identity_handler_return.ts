import { sourceEditSpan } from "../syntax.ts";
import type { LintRule } from "../types.ts";

export const identityHandlerReturn: LintRule = {
  name: "identity-handler-return",
  code: "BLOT_LINT_IDENTITY_HANDLER_RETURN",
  severity: "hint",
  create(context) {
    return {
      expression({ node }) {
        if (
          node.tag !== "apply" || node.fn.tag !== "intrinsic" ||
          node.fn.name !== "@handle" ||
          node.arg.tag !== "tuple" || node.arg.elements.length !== 3
        ) return;
        const handler = node.arg.elements[2];
        if (
          handler.tag !== "shape" ||
          !context.hasConcreteOrigin(handler, "shape") ||
          handler.members.some((member) => member.tag !== "field")
        ) return;
        const clause = handler.members.find((member) =>
          member.tag === "field" && member.name === "return"
        );
        if (
          clause === undefined || clause.value.tag !== "lambda" ||
          clause.value.deferred ||
          clause.value.parameter.tag !== "name" ||
          clause.value.parameter.qualifier !== "none" ||
          clause.value.body.tag !== "var" ||
          clause.value.body.name !== clause.value.parameter.name
        ) return;
        const start = context.source.lastIndexOf(
          ".return",
          clause.value.span.start,
        );
        const end = context.source.indexOf(";", clause.value.span.end);
        if (start < handler.span.start || end < 0 || end >= handler.span.end) {
          return;
        }
        const span = sourceEditSpan(context.source, { start, end: end + 1 });
        context.report({
          message:
            "A handler already returns its normal result unchanged when the return clause is omitted.",
          span,
          fix: context.fix(
            span,
            "Remove identity handler return clause",
            "",
            "check-interface",
          ),
        });
      },
    };
  },
};
