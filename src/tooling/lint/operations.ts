import { type Expr, patternNames, type Span } from "../../syntax/ast.ts";
import type { CompilerReadabilityFact } from "../../compiler/wasm.ts";
import { expressionReads, spanKey } from "./syntax.ts";
import type { AstNode, LintRuleContext } from "./types.ts";

export function readsDeferredParameter(
  expression: Expr,
  ancestors: readonly AstNode[],
): boolean {
  return ancestors.some((ancestor) =>
    "tag" in ancestor && ancestor.tag === "lambda" && ancestor.deferred &&
    expressionReads(expression, new Set(patternNames(ancestor.parameter)))
  );
}

export function sourceOperations(
  context: LintRuleContext,
  expression: { readonly span: Span },
): Extract<CompilerReadabilityFact, { kind: "source-operations" }> | undefined {
  return context.readability.find((
    fact,
  ): fact is Extract<CompilerReadabilityFact, { kind: "source-operations" }> =>
    fact.kind === "source-operations" &&
    spanKey(fact.span) === spanKey(expression.span)
  );
}

export function sourceIndent(source: string, offset: number): string {
  const start = source.lastIndexOf("\n", offset - 1) + 1;
  const indentation = /^[ \t]*/.exec(source.slice(start, offset));
  if (indentation === null) throw new Error("A source line has no indentation");
  return indentation[0];
}

export function appliedConstructor(
  expression: Expr,
  name: string,
): Expr | null {
  if (
    expression.tag === "apply" && expression.fn.tag === "tag" &&
    expression.fn.name === name
  ) return expression.arg;
  return null;
}
