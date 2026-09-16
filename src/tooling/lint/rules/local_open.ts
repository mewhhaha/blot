import type { Decl, Expr } from "../../../syntax/ast.ts";
import { patternNames } from "../../../syntax/ast.ts";
import {
  declarationSequenceReads,
  expressionReads,
  spanKey,
  statementRemovalSpan,
} from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

export const localOpen: LintRule = {
  name: "local-open",
  code: "BLOT_LINT_LOCAL_OPEN",
  severity: "hint",
  evidence: "semantic-fact",
  create(context) {
    return {
      module: ({ node }) => inspect(node.declarations, node.result, context),
      expression({ node }) {
        if (node.tag === "block") {
          inspect(node.declarations, node.result, context);
        }
      },
    };
  },
};

function inspect(
  declarations: readonly Decl[],
  result: Expr,
  context: LintRuleContext,
): void {
  for (let index = 0; index < declarations.length; index += 1) {
    const opening = declarations[index];
    if (
      opening.tag !== "open" || opening.value.tag !== "var" ||
      !context.hasConcreteOrigin(opening, "opening")
    ) continue;
    const fact = context.readability.find((fact) =>
      fact.kind === "open-usage" &&
      spanKey(fact.span) === spanKey(opening.value.span)
    );
    if (
      fact?.kind !== "open-usage" || fact.used.length === 0 ||
      fact.shadowed.length !== 0
    ) continue;
    const names = new Set(fact.used);
    const openedName = opening.value.name;
    const candidates = declarations.slice(index + 1).filter((declaration) =>
      declaration.tag === "binding" && expressionReads(declaration.value, names)
    );
    if (candidates.length !== 1) continue;
    const candidate = candidates[0];
    if (
      candidate.tag !== "binding" || candidate.value.tag !== "lambda" ||
      candidate.value.body.tag !== "block" ||
      !context.hasConcreteOrigin(candidate.value.body, "do_block") ||
      patternNames(candidate.value.parameter).some((name) =>
        names.has(name) || name === openedName
      )
    ) continue;
    const others = declarations.slice(index + 1).filter((declaration) =>
      declaration !== candidate
    );
    if (declarationSequenceReads(others, result, names)) continue;
    if (
      others.some((declaration) =>
        declaration.tag === "open" ||
        declaration.tag === "binding" &&
          patternNames(declaration.pattern).some((name) =>
            names.has(name) || name === openedName
          )
      )
    ) continue;
    const block = candidate.value.body;
    const lineEnd = context.source.indexOf("\n", block.span.start);
    if (lineEnd < 0) continue;
    const lineStart = context.source.lastIndexOf("\n", block.span.start - 1) +
      1;
    const indentation = context.source.slice(lineStart, block.span.start).match(
      /^[ \t]*/,
    )?.[0];
    if (indentation === undefined) {
      throw new Error("A block has no source indentation");
    }
    context.report({
      message: "This opened vocabulary is only used inside one function.",
      span: opening.span,
      fix: context.fixEdits({
        title: "Open the vocabulary inside its function",
        kind: "refactor.rewrite",
        validation: "check-interface",
        edits: [
          {
            span: statementRemovalSpan(context.source, opening.span),
            replacement: "",
          },
          {
            span: { start: lineEnd + 1, end: lineEnd + 1 },
            replacement: indentation + "  open " + openedName + "\n",
          },
        ],
      }),
    });
  }
}
