import type { Decl, RecursiveMember, Span } from "../../../syntax/ast.ts";
import { recursiveGroups } from "../../../syntax/ast.ts";
import { field } from "../../../syntax/cursor.ts";
import { expressionReads, spanKey } from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

interface Candidate {
  readonly names: readonly string[];
  readonly members: readonly CandidateMember[];
}

interface CandidateMember {
  readonly binding: RecursiveMember["declaration"];
  readonly signature: Extract<Decl, { readonly tag: "signature" }> | null;
}

export const unnecessaryRec: LintRule = {
  name: "unnecessary-rec",
  code: "BLOT_LINT_UNNECESSARY_REC",
  severity: "hint",
  create(context) {
    const candidates = new Map<string, Candidate>();
    const signatureMarkers = new Map<string, Span>();
    const bindingMarkers = new Map<string, Span>();
    return {
      module(path) {
        collectCandidates(path.node.declarations, context, candidates);
      },
      expression(path) {
        if (path.node.tag !== "block") return;
        collectCandidates(path.node.declarations, context, candidates);
      },
      concrete(rule) {
        if (rule.name === "signature") {
          const marker = field(rule, "recursive");
          if (marker !== null) {
            signatureMarkers.set(spanKey(rule.span), marker.span);
          }
          return;
        }
        if (rule.name !== "binding") return;
        const bindingMarker = field(rule, "recursive");
        if (bindingMarker === null) return;
        bindingMarkers.set(spanKey(rule.span), bindingMarker.span);
        const candidate = candidates.get(spanKey(rule.span));
        if (candidate === undefined) return;

        const removals: Span[] = [];
        for (const member of candidate.members) {
          const memberMarker = bindingMarkers.get(spanKey(member.binding.span));
          if (memberMarker === undefined) return;
          removals.push(markerRemoval(memberMarker, context.source));
          if (member.signature !== null && member.signature.recursive) {
            const signatureMarker = signatureMarkers.get(
              spanKey(member.signature.span),
            );
            if (signatureMarker === undefined) return;
            removals.push(markerRemoval(signatureMarker, context.source));
          }
        }
        removals.sort((left, right) => left.start - right.start);
        const firstRemoval = removals[0];
        const lastRemoval = removals.at(-1);
        if (firstRemoval === undefined || lastRemoval === undefined) {
          throw new Error(
            `recursive group ${
              candidate.names.join(", ")
            } lost its rec markers`,
          );
        }
        const fixSpan = {
          start: firstRemoval.start,
          end: lastRemoval.end,
        };
        const replacement = removeSpans(
          context.source,
          fixSpan,
          removals,
        );
        const formattedNames = candidate.names.map((name) => `\`${name}\``)
          .join(", ");
        let message =
          `${formattedNames} does not refer to itself; remove its \`rec\` marker.`;
        if (candidate.names.length > 1) {
          message =
            `${formattedNames} do not refer to their recursive group; remove their \`rec\` markers.`;
        }
        context.report({
          message,
          span: fixSpan,
          fix: context.fix(
            fixSpan,
            "Remove unnecessary `rec`",
            replacement,
            "check-interface",
          ),
        });
      },
    };
  },
};

function collectCandidates(
  declarations: readonly Decl[],
  context: LintRuleContext,
  candidates: Map<string, Candidate>,
): void {
  const groups = recursiveGroups(declarations);
  const visited = new Set<readonly RecursiveMember[]>();
  for (const declaration of declarations) {
    const group = groups.get(declaration);
    if (group === undefined || visited.has(group)) continue;
    visited.add(group);
    if (
      group.some((member) =>
        !context.hasConcreteOrigin(member.declaration, "binding")
      )
    ) continue;
    const names = group.map((member) => member.name);
    const recursiveNames = new Set(names);
    if (
      group.some((member) => expressionReads(member.lambda, recursiveNames))
    ) continue;

    const members: CandidateMember[] = [];
    let valid = true;
    for (const member of group) {
      const index = declarations.indexOf(member.declaration);
      const previous = declarations[index - 1];
      let signature: Extract<Decl, { readonly tag: "signature" }> | null = null;
      if (previous?.tag === "signature") {
        if (
          previous.name !== member.name ||
          previous.kind !== member.declaration.kind
        ) {
          valid = false;
          break;
        }
        signature = previous;
      }
      members.push({ binding: member.declaration, signature });
    }
    if (!valid) continue;
    const last = group.at(-1);
    if (last === undefined) continue;
    candidates.set(spanKey(last.declaration.span), { names, members });
  }
}

function markerRemoval(marker: Span, source: string): Span {
  const whitespace = /^[ \t]+/.exec(source.slice(marker.end));
  let end = marker.end;
  if (whitespace !== null) end += whitespace[0].length;
  return { start: marker.start, end };
}

function removeSpans(
  source: string,
  enclosing: Span,
  removals: readonly Span[],
): string {
  let replacement = "";
  let position = enclosing.start;
  for (const removal of removals) {
    replacement += source.slice(position, removal.start);
    position = removal.end;
  }
  return replacement + source.slice(position, enclosing.end);
}
