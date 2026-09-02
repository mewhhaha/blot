import type { Rule } from "../../../syntax/cursor.ts";
import {
  fieldRule,
  fieldRules,
  lineComments,
  sourceCodeSpan,
  sourceEditSpan,
  spanKey,
} from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

interface FlattenedArm {
  readonly patterns: readonly string[];
  readonly body: Rule;
  readonly comments: readonly string[];
}

interface FlattenedCases {
  readonly subjects: readonly string[];
  readonly arms: readonly FlattenedArm[];
  readonly cases: readonly Rule[];
}

export const nestedCaseChain: LintRule = {
  name: "nested-case-chain",
  code: "BLOT_LINT_NESTED_CASE_CHAIN",
  severity: "hint",
  create(context) {
    const covered = new Set<string>();
    return {
      concrete(rule) {
        if (rule.name !== "case_expression") return;
        if (covered.has(spanKey(rule.span))) return;
        const flattened = flattenCases(rule, context);
        if (flattened === null || flattened.cases.length < 2) return;
        for (const nested of flattened.cases.slice(1)) {
          covered.add(spanKey(nested.span));
        }
        const indent = lineIndent(context.source, rule.span.start);
        const codeSpan = sourceCodeSpan(context.source, rule.span);
        const editSpan = sourceEditSpan(context.source, rule.span);
        const replacement = renderCases(flattened, context, indent) +
          context.source.slice(codeSpan.end, editSpan.end);
        context.report({
          message:
            "This nested case tree is one decision matrix; match its subjects in a single multi-subject `case`.",
          span: rule.span,
          fix: context.fix(
            editSpan,
            "Flatten nested cases",
            replacement,
            "check",
          ),
        });
      },
    };
  },
};

function flattenCases(
  root: Rule,
  context: LintRuleContext,
): FlattenedCases | null {
  const subjects: string[] = [];
  const arms: FlattenedArm[] = [];
  const cases: Rule[] = [];

  function visit(
    rule: Rule,
    prefix: readonly string[],
    inheritedComments: readonly string[] = [],
  ): boolean {
    const targets = fieldRules(rule, "targets");
    if (targets.length !== 1 || fieldRules(rule, "rest").length < 1) {
      return false;
    }
    const target = targets[0];
    if (target === undefined) return false;
    const subject = singleLine(context.sourceText(target));
    if (subject.length === 0) return false;
    const existing = subjects[prefix.length];
    if (existing === undefined) subjects.push(subject);
    else if (existing !== subject) return false;
    cases.push(rule);

    let previousEnd = target.span.end;
    let firstArm = true;
    for (const arm of caseArms(rule)) {
      if (fieldRule(arm, "guard") !== null) return false;
      const patterns = fieldRules(arm, "patterns");
      if (patterns.length !== 1) return false;
      const pattern = patterns[0];
      const body = fieldRule(arm, "body");
      if (pattern === undefined || body === null) return false;
      const comments = lineComments(
        context.source.slice(previousEnd, pattern.span.start),
      );
      const leadingComments = firstArm
        ? [...inheritedComments, ...comments]
        : comments;
      const writtenPattern = singleLine(context.sourceText(pattern));
      const nested = directCaseBody(body);
      if (nested === null) {
        arms.push({
          patterns: [...prefix, writtenPattern],
          body,
          comments: leadingComments,
        });
      } else {
        if (patternMayBind(writtenPattern)) return false;
        if (
          !visit(
            nested,
            [...prefix, writtenPattern],
            leadingComments,
          )
        ) return false;
      }
      previousEnd = sourceCodeSpan(context.source, body.span).end;
      firstArm = false;
    }
    return true;
  }

  if (!visit(root, [])) return null;
  return { subjects, arms, cases };
}

function renderCases(
  flattened: FlattenedCases,
  context: LintRuleContext,
  indent: string,
): string {
  const armIndent = `${indent}  `;
  const arms = flattened.arms.map((arm) => {
    const patterns = [...arm.patterns];
    while (patterns.length < flattened.subjects.length) patterns.push("_");
    const body = renderArm(patterns.join(", "), arm.body, context, armIndent);
    if (arm.comments.length === 0) return body;
    const comments = arm.comments.map((comment) => `${armIndent}${comment}`);
    return `${comments.join("\n")}\n${body}`;
  });
  return `case ${flattened.subjects.join(", ")} of\n${arms.join("\n")}`;
}

function renderArm(
  patterns: string,
  body: Rule,
  context: LintRuleContext,
  indent: string,
): string {
  const span = sourceCodeSpan(context.source, body.span);
  const source = context.source.slice(span.start, span.end).trimEnd();
  const lines = source.split("\n");
  const first = lines[0]?.trimStart();
  if (first === undefined) {
    throw new Error("a nested case arm lost its body");
  }
  if (lines.length === 1) return `${indent}${patterns} => ${first}`;

  const continuationIndent = smallestIndent(lines.slice(1));
  const rendered = [`${indent}${patterns} => ${first}`];
  for (const line of lines.slice(1)) {
    let content = line;
    if (content.startsWith(continuationIndent)) {
      content = content.slice(continuationIndent.length);
    }
    rendered.push(`${indent}  ${content}`.trimEnd());
  }
  return rendered.join("\n");
}

function directCaseBody(body: Rule): Rule | null {
  let found: Rule | null = null;
  const visit = (rule: Rule): void => {
    if (found !== null) return;
    if (
      rule.name === "case_expression" && rule.span.start === body.span.start &&
      rule.span.end === body.span.end
    ) {
      found = rule;
      return;
    }
    for (const child of rule.children()) {
      if (child.type === "rule") visit(child);
    }
  };
  visit(body);
  return found;
}

function caseArms(rule: Rule): readonly Rule[] {
  const first = fieldRule(rule, "first");
  if (first === null) return [];
  return [first, ...fieldRules(rule, "rest")];
}

function patternMayBind(pattern: string): boolean {
  return /(?:^|[^.#A-Za-z0-9_^])[a-z][A-Za-z0-9_]*/.test(pattern);
}

function smallestIndent(lines: readonly string[]): string {
  let smallest: string | null = null;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const match = /^[ \t]*/.exec(line);
    let indent = "";
    if (match !== null && match[0] !== undefined) indent = match[0];
    if (smallest === null || indent.length < smallest.length) smallest = indent;
  }
  if (smallest === null) return "";
  return smallest;
}

function singleLine(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

function lineIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, offset));
  if (match === null || match[0] === undefined) return "";
  return match[0];
}
