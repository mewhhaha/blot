import type { CompilerReadabilityFact } from "../../../compiler/wasm.ts";
import type { Expr, ShapeMember, Span } from "../../../syntax/ast.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

type RecordReconstructionFact = Extract<
  CompilerReadabilityFact,
  { readonly kind: "record-reconstruction" }
>;

export const recordReconstruction: LintRule = {
  name: "record-reconstruction",
  code: "BLOT_LINT_RECORD_RECONSTRUCTION",
  severity: "hint",
  create(context) {
    return {
      expression(path) {
        const expression = path.node;
        if (expression.tag !== "shape") return;
        if (!context.hasConcreteOrigin(expression, "shape")) return;
        const fact = context.readability.find((
          candidate,
        ): candidate is RecordReconstructionFact =>
          candidate.kind === "record-reconstruction" &&
          sameSpan(candidate.span, expression.span)
        );
        if (fact === undefined) return;
        const source = spanText(context.source, fact.source);
        const replacement = renderReconstruction(expression, fact, context);
        let message =
          `This record repeats fields from \`${source}\`; spread that exact record and keep only the changed fields.`;
        let title = `Spread \`${source}\` instead of copying its fields`;
        if (fact.retained.length === 0) {
          message =
            `This record reconstructs \`${source}\` without changing it; use the original value.`;
          title = `Use \`${source}\` directly`;
        }
        context.report({
          message,
          span: expression.span,
          fix: context.fix(
            expression.span,
            title,
            replacement,
            "check-interface",
          ),
        });
      },
    };
  },
};

function renderReconstruction(
  expression: Extract<Expr, { readonly tag: "shape" }>,
  fact: RecordReconstructionFact,
  context: LintRuleContext,
): string {
  const reconstructed = spanText(context.source, fact.source);
  if (fact.retained.length === 0) return reconstructed;
  const retained = fact.retained.map((name) =>
    retainedField(expression.members, name, fact)
  );
  const source = context.source.slice(
    expression.span.start,
    expression.span.end,
  );
  if (
    !source.includes("\n") &&
    retained.every((member) => !context.sourceText(member.value).includes("\n"))
  ) {
    const members = retained.map((member) => renderMember(member, context));
    return `{ ...${reconstructed}; ${members.join(" ")} }`;
  }

  const indent = lineIndent(context.source, expression.span.start);
  const memberIndent = `${indent}  `;
  const members = retained.map((member) =>
    `${memberIndent}${renderMember(member, context)}`
  );
  return `{
${memberIndent}...${reconstructed};
${members.join("\n")}
${indent}}`;
}

function retainedField(
  members: readonly ShapeMember[],
  name: string,
  fact: RecordReconstructionFact,
): Extract<ShapeMember, { readonly tag: "field" }> {
  const member = members.find((candidate) =>
    candidate.tag === "field" && candidate.name === name
  );
  if (member === undefined || member.tag !== "field") {
    throw new Error(
      `blot invariant violated: record reconstruction at ${fact.span.start} retains missing field ${name}`,
    );
  }
  return member;
}

function renderMember(
  member: Extract<ShapeMember, { readonly tag: "field" }>,
  context: LintRuleContext,
): string {
  return `.${member.name} = ${context.sourceText(member.value)};`;
}

function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, offset));
  if (match === null) return "";
  return match[0];
}

function spanText(source: string, span: Span): string {
  return source.slice(span.start, span.end).trim();
}

function sameSpan(left: Span, right: Span): boolean {
  return left.start === right.start && left.end === right.end;
}
