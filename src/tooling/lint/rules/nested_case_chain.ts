import type { Rule } from "../../../syntax/cursor.ts";
import { spanKey } from "../syntax.ts";
import type { LintRule, LintRuleContext } from "../types.ts";

interface FlattenedArm {
  readonly patterns: readonly string[];
  readonly body: Rule;
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
        if (flattened === null || flattened.cases.length < 3) return;
        for (const nested of flattened.cases.slice(1)) {
          covered.add(spanKey(nested.span));
        }
        const indent = lineIndent(context.source, rule.span.start);
        context.report({
          message:
            "This nested case tree is one decision matrix; match its subjects in a single multi-subject `case`.",
          span: rule.span,
          fix: context.fix(
            rule.span,
            "Flatten nested cases",
            renderCases(flattened, context, indent),
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

  function visit(rule: Rule, prefix: readonly string[]): boolean {
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

    for (const arm of caseArms(rule)) {
      if (fieldRule(arm, "guard") !== null) return false;
      const patterns = fieldRules(arm, "patterns");
      if (patterns.length !== 1) return false;
      const pattern = patterns[0];
      const body = fieldRule(arm, "body");
      if (pattern === undefined || body === null) return false;
      const writtenPattern = singleLine(context.sourceText(pattern));
      const nested = directCaseBody(body);
      if (nested === null) {
        arms.push({ patterns: [...prefix, writtenPattern], body });
        continue;
      }
      if (patternMayBind(writtenPattern)) return false;
      if (!visit(nested, [...prefix, writtenPattern])) return false;
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
    return renderArm(patterns.join(", "), arm.body, context, armIndent);
  });
  return `case ${flattened.subjects.join(", ")} of\n${arms.join("\n")}`;
}

function renderArm(
  patterns: string,
  body: Rule,
  context: LintRuleContext,
  indent: string,
): string {
  const source = context.source.slice(body.span.start, body.span.end).trimEnd();
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

function fieldRule(rule: Rule, name: string): Rule | null {
  const value = rule.field(name);
  if (value === undefined || value === null || Array.isArray(value)) {
    return null;
  }
  if (typeof value !== "object" || !("type" in value)) return null;
  if (value.type !== "rule") return null;
  return value as Rule;
}

function fieldRules(rule: Rule, name: string): readonly Rule[] {
  const value = rule.field(name);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Rule =>
    entry !== null && entry !== undefined && entry.type === "rule"
  );
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
  return smallest ?? "";
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
