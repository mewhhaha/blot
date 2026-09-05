import {
  declaredFixities,
  type Fixity,
  resolveFixities,
} from "../../../syntax/fixity.ts";
import type { Expr } from "../../../syntax/ast.ts";
import { binaryCall, calleePath } from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

export const operatorSpelling: LintRule = {
  name: "operator-spelling",
  code: "BLOT_LINT_OPERATOR_SPELLING",
  severity: "hint",
  create(context) {
    const fixities = resolveFixities(declaredFixities(context.cst));
    const infix = activeOperators("infix", fixities);
    const prefix = activeOperators("prefix", fixities);
    return {
      expression(path) {
        const binary = binaryCall(path.node);
        if (binary !== null) {
          reportBinary(binary, path.node, infix, context);
          return;
        }
        if (path.node.tag !== "apply") return;
        const target = calleePath(path.node.fn)?.join(".");
        if (target === undefined) return;
        const operator = prefix.get(target);
        if (operator === undefined) return;
        if (!context.sourceText(path.node).startsWith(`${target} `)) return;
        context.report({
          message:
            `Use the conventional prefix \`${operator}\` spelling for \`${target}\`.`,
          span: path.node.span,
          fix: context.fix(
            path.node.span,
            `Replace \`${target}\` with prefix \`${operator}\``,
            `(${operator}${context.sourceText(path.node.arg)})`,
          ),
        });
      },
    };
  },
};

function activeOperators(
  kind: "infix" | "prefix",
  fixities: readonly Fixity[],
): ReadonlyMap<string, string> {
  const byOperator = new Map<string, Fixity>();
  for (const fixity of fixities) {
    if ((fixity.associativity === "prefix") === (kind === "prefix")) {
      byOperator.set(fixity.operator, fixity);
    }
  }
  const byTarget = new Map<string, string | null>();
  for (const fixity of byOperator.values()) {
    const target = fixity.target.join(".");
    if (byTarget.has(target)) {
      byTarget.set(target, null);
    } else {
      byTarget.set(target, fixity.operator);
      if (fixity.target[0] === "Op") {
        const intTarget = ["Int", ...fixity.target.slice(1)].join(".");
        if (!byTarget.has(intTarget)) {
          byTarget.set(intTarget, fixity.operator);
        }
      }
    }
  }
  return new Map(
    [...byTarget].filter((entry): entry is [string, string] =>
      entry[1] !== null
    ),
  );
}

function reportBinary(
  call: NonNullable<ReturnType<typeof binaryCall>>,
  expression: Expr,
  operators: ReadonlyMap<string, string>,
  context: LintRuleContext,
): void {
  const target = calleePath(call.callee)?.join(".");
  if (target === undefined) return;
  const operator = operators.get(target);
  if (operator === undefined) return;
  if (!context.sourceText(expression).startsWith(`${target} `)) return;
  context.report({
    message: `Use the conventional \`${operator}\` spelling for \`${target}\`.`,
    span: expression.span,
    fix: context.fix(
      expression.span,
      `Replace \`${target}\` with \`${operator}\``,
      `(${context.sourceText(call.left)} ${operator} ${
        context.sourceText(call.right)
      })`,
    ),
  });
}
