import type { Expr } from "../../../syntax/ast.ts";
import { declaredFixities, resolveFixities } from "../../../syntax/fixity.ts";
import { calleePath } from "../syntax.ts";
import type { LintRule } from "../types.ts";

export const handlerPipeline: LintRule = {
  name: "handler-pipeline",
  code: "BLOT_LINT_HANDLER_PIPELINE",
  severity: "hint",
  evidence: "syntax-only",
  create(context) {
    const pipe = resolveFixities(declaredFixities(context.cst)).find((fixity) =>
      fixity.operator === "|>" && fixity.associativity !== "prefix"
    );
    if (pipe === undefined || pipe.target.join(".") !== "Fn.pipe") return {};
    return {
      expression({ node, ancestors }) {
        if (
          node.tag !== "lambda" || node.parameter.tag !== "unit" ||
          node.deferred ||
          !context.hasConcreteOrigin(node, "lambda") ||
          ancestors.some((ancestor) =>
            "tag" in ancestor && ancestor.tag === "lambda" &&
            ancestor.parameter.tag === "unit" && handles(ancestor.body)
          )
        ) return;
        const steps: { effect: Expr; handler: Expr }[] = [];
        let computation: Expr = node;
        while (
          computation.tag === "lambda" &&
          computation.parameter.tag === "unit" && !computation.deferred &&
          handles(computation.body)
        ) {
          const [effect, inner, handler]: readonly Expr[] =
            computation.body.arg.elements;
          if (calleePath(effect) === null || calleePath(handler) === null) {
            return;
          }
          steps.unshift({ effect, handler });
          computation = inner;
        }
        if (steps.length < 2 || computation.tag !== "var") return;
        const lineStart =
          context.source.lastIndexOf("\n", node.span.start - 1) + 1;
        const indentation = context.source.slice(lineStart, node.span.start)
          .match(/^[ \t]*/)?.[0];
        if (indentation === undefined) {
          throw new Error("A lambda has no source indentation");
        }
        const indent = indentation + "  ";
        const replacement = context.sourceText(computation) +
          steps.map((step) =>
            "\n" + indent + "|> @handle (" + context.sourceText(step.effect) +
            ", " + context.sourceText(step.handler) + ")"
          ).join("");
        context.report({
          message:
            "These nested handler computations form a pipeline in inner-to-outer order.",
          span: node.span,
          fix: context.fix(
            node.span,
            "Compose handlers as a pipeline",
            replacement,
            "check-interface",
            "refactor.rewrite",
          ),
        });
      },
    };
  },
};

function handles(
  expression: Expr,
): expression is Extract<Expr, { tag: "apply" }> & {
  arg: Extract<Expr, { tag: "tuple" }>;
} {
  return expression.tag === "apply" && expression.fn.tag === "intrinsic" &&
    expression.fn.name === "@handle" && expression.arg.tag === "tuple" &&
    expression.arg.elements.length === 3;
}
