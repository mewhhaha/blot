import type { Diagnostic } from "../diagnostic.ts";
import { parse } from "../syntax/parse.ts";
import type { Module, Span } from "../syntax/ast.ts";
import type { Rule, TokenCursor } from "../syntax/lower.ts";
import { formatSource } from "../tooling/formatter.ts";
import { parseLegacySource } from "./legacy_parse.ts";

export type MigrationResult =
  | { readonly ok: true; readonly source: string }
  | {
    readonly ok: false;
    readonly diagnostics: readonly Diagnostic[];
    readonly migratedSource?: string;
  };

interface Edit extends Span {
  readonly text: string;
}

type Cursor = Rule | TokenCursor;

const lineTerminatedRules = new Set([
  "binding",
  "breaking",
  "conditional_statement",
  "handler_composition_step",
  "module_header",
  "opening",
  "operator_section",
  "rebinding",
  "result",
]);

export async function migrateLayoutSource(
  source: string,
): Promise<MigrationResult> {
  const legacy = await parseLegacySource(source);
  if (!legacy.ok) {
    const rewritten = rewriteValueConditionalTokens(source);
    if (rewritten === source) return legacy;
    const formatted = await formatSource(rewritten);
    if (!formatted.ok) return legacy;
    return { ok: true, source: formatted.source };
  }

  const edits: Edit[] = [];
  collectEdits(legacy.cst, source, edits);
  const rewritten = applyEdits(source, edits)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
  // Rewriting the layout can leave a `return` around a conditional that is now
  // the statement form's own control flow. The formatter already knows to drop
  // one, and its result is what a migrated file should look like anyway.
  const normalized = await formatSource(rewritten);
  const migrated = normalized.ok ? normalized.source : rewritten;
  const reparsed = await parse(migrated);
  if (legacy.module === null) {
    if (legacy.diagnostic === null) {
      throw new Error("A failed legacy elaboration omitted its diagnostic.");
    }
    if (reparsed.ok) {
      throw new Error(
        `Layout migration made rejected source pass; legacy diagnostic was ${legacy.diagnostic.code}.`,
      );
    }
    if (reparsed.diagnostics[0]?.code !== legacy.diagnostic.code) {
      return { ...reparsed, migratedSource: migrated };
    }
    return { ok: true, source: migrated };
  }
  if (!reparsed.ok) return { ...reparsed, migratedSource: migrated };
  const migratedTree = semanticTree(reparsed.module);
  const legacyTree = semanticTree(legacy.module);
  if (migratedTree !== legacyTree) {
    const difference = firstDifference(legacyTree, migratedTree);
    throw new Error(
      `Layout migration changed the elaborated module at tree offset ${difference}: legacy ${
        JSON.stringify(legacyTree.slice(difference, difference + 120))
      }, migrated ${
        JSON.stringify(migratedTree.slice(difference, difference + 120))
      }.\n${migrated}`,
    );
  }
  const formatted = await formatSource(migrated);
  if (!formatted.ok) {
    throw new Error("Layout migration produced source the formatter rejected.");
  }
  return { ok: true, source: formatted.source };
}

function rewriteValueConditionalTokens(source: string): string {
  let rewritten = "";
  let offset = 0;
  while (offset < source.length) {
    if (source.startsWith("//", offset)) {
      const lineEnd = source.indexOf("\n", offset);
      if (lineEnd < 0) return rewritten + source.slice(offset);
      rewritten += source.slice(offset, lineEnd);
      offset = lineEnd;
      continue;
    }
    if (source[offset] === '"') {
      const start = offset;
      offset += 1;
      while (offset < source.length) {
        if (source[offset] === "\\") {
          offset += 2;
          continue;
        }
        if (source[offset] === '"') {
          offset += 1;
          break;
        }
        offset += 1;
      }
      rewritten += source.slice(start, offset);
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(offset))?.[0];
    if (word === undefined) {
      rewritten += source[offset];
      offset += 1;
      continue;
    }
    if (word === "then") {
      rewritten += ":";
    } else if (word === "else") {
      const remainder = source.slice(offset + word.length);
      const nextWord = /^\s*([A-Za-z_][A-Za-z0-9_]*|:)/.exec(remainder)?.[1];
      rewritten += nextWord === "if" || nextWord === ":" ? "else" : "else:";
    } else {
      rewritten += word;
    }
    offset += word.length;
  }
  return rewritten;
}

function collectEdits(rule: Rule, source: string, edits: Edit[]): void {
  if (lineTerminatedRules.has(rule.name)) {
    const terminator = directToken(rule, ";");
    if (terminator !== null) replaceToken(terminator, "", edits);
  }

  if (
    rule.name === "binding" || rule.name === "rebinding" ||
    rule.name === "result"
  ) {
    indentPlainValueContinuations(rule, source, edits);
  }

  if (rule.name === "block") migrateBlock(rule, source, edits);
  if (rule.name === "binding" || rule.name === "rebinding") {
    normalizeAssignedValue(rule, source, edits);
  }
  if (rule.name === "lambda") normalizeLambdaBody(rule, source, edits);
  if (rule.name === "iteration") migrateIteration(rule, source, edits);
  if (rule.name === "conditional") {
    migrateConditional(rule, source, edits);
  }
  if (rule.name === "conditional_statement") {
    migrateConditionalStatement(rule, source, edits);
  }
  if (rule.name === "case_expression") migrateCase(rule, source, edits);
  if (rule.name === "handler_composition") {
    migrateHandlerComposition(rule, source, edits);
  }
  if (rule.name === "element_body") migrateElementBody(rule, source, edits);

  for (const child of rule.children()) {
    if (child.type === "rule") collectEdits(child, source, edits);
  }
}

function migrateBlock(rule: Rule, source: string, edits: Edit[]): void {
  const opening = requiredToken(rule, "do");
  const closing = requiredToken(rule, "end");
  const statements = fieldRules(rule, "statements");
  const indent = effectiveLineIndent(source, rule.span.start, edits);
  if (statements.length === 0) {
    edits.push({
      start: opening.span.start,
      end: closing.span.end,
      text: "()",
    });
    return;
  }
  replaceGap(
    source,
    precedingHorizontalWhitespace(source, opening.span.start),
    statements[0].span.start,
    indent + 2,
    edits,
  );
  separateStatements(statements, source, indent + 2, edits);
  const enclosingTerminatorIsRemoved = edits.some((edit) =>
    edit.start === closing.span.end && edit.end === closing.span.end + 1 &&
    edit.text === ""
  );
  if (enclosingTerminatorIsRemoved) {
    removeClosingGap(
      source,
      statements.at(-1)!.span.end,
      closing.span.end,
      indent,
      edits,
    );
  } else {
    replaceGap(
      source,
      statements.at(-1)!.span.end,
      closing.span.end,
      indent,
      edits,
    );
  }
}

function indentPlainValueContinuations(
  rule: Rule,
  source: string,
  edits: Edit[],
): void {
  const value = optionalRule(rule, "value");
  if (value === null || containsLayoutRule(value)) return;
  const indent = effectiveLineIndent(source, rule.span.start, edits) + 2;
  indentValueContinuations(value, indent, source, edits);
}

function indentValueContinuations(
  value: Rule,
  indent: number,
  source: string,
  edits: Edit[],
): void {
  let lineStart = source.indexOf("\n", value.span.start);
  while (lineStart >= 0 && lineStart < value.span.end) {
    lineStart += 1;
    let content = lineStart;
    while (
      content < value.span.end &&
      (source[content] === " " || source[content] === "\t")
    ) content += 1;
    if (
      content < value.span.end && source[content] !== "\r" &&
      source[content] !== "\n"
    ) {
      const overlaps = edits.some((edit) =>
        edit.start < content && edit.end > lineStart
      ) || hasFutureNormalization(value, lineStart, content);
      if (!overlaps) {
        edits.push({
          start: lineStart,
          end: content,
          text: " ".repeat(indent),
        });
      }
    }
    lineStart = source.indexOf("\n", content);
  }
}

function hasFutureNormalization(
  rule: Rule,
  start: number,
  end: number,
): boolean {
  if (rule.name === "lambda") {
    const body = requiredRule(rule, "body");
    if (!rootRuleIs(body, "block")) {
      const parameters = fieldRules(rule, "parameters");
      const lastParameter = parameters.at(-1);
      if (lastParameter === undefined) {
        throw new Error("A lambda has no parameter.");
      }
      const arrow = requiredToken(lastParameter, "=>");
      if (arrow.span.end < end && body.span.start > start) return true;
    }
  }
  return rule.children().some((child) =>
    child.type === "rule" && hasFutureNormalization(child, start, end)
  );
}

function containsLayoutRule(rule: Rule): boolean {
  if (
    rule.name === "block" || rule.name === "case_expression" ||
    rule.name === "conditional" || rule.name === "handler_composition" ||
    rule.name === "element_expression"
  ) return true;
  return rule.children().some((child) =>
    child.type === "rule" && containsLayoutRule(child)
  );
}

function migrateIteration(rule: Rule, source: string, edits: Edit[]): void {
  const opening = requiredToken(rule, "do");
  const closing = requiredToken(rule, "end");
  const statements = fieldRules(rule, "body");
  const indent = effectiveLineIndent(source, rule.span.start, edits);
  if (statements.length === 0) {
    throw new Error("An empty legacy `for` has no layout-suite spelling.");
  }
  replaceGap(
    source,
    precedingHorizontalWhitespace(source, opening.span.start),
    statements[0].span.start,
    indent + 2,
    edits,
    ":",
  );
  separateStatements(statements, source, indent + 2, edits);
  removeClosingGap(
    source,
    statements.at(-1)!.span.end,
    closing.span.end,
    indent,
    edits,
  );
  const terminator = directToken(rule, ";");
  if (terminator !== null) replaceToken(terminator, "", edits);
}

function migrateConditionalStatement(
  rule: Rule,
  source: string,
  edits: Edit[],
): void {
  const body = requiredRule(rule, "body");
  const indent = effectiveLineIndent(source, rule.span.start, edits);
  const end = requiredToken(rule, "end");
  const branches: {
    readonly introducer: TokenCursor;
    readonly startsAt: number;
    readonly body: Rule[];
  }[] = [];
  if (body.name === "conditional_statement_guard") {
    const introducer = requiredToken(body, "else");
    branches.push({
      introducer,
      startsAt: introducer.span.start,
      body: fieldRules(body, "alternative"),
    });
  } else {
    const introducer = requiredToken(body, "then");
    branches.push({
      introducer,
      startsAt: introducer.span.start,
      body: fieldRules(body, "consequence"),
    });
    for (const alternative of fieldRules(body, "alternatives")) {
      const alternativeStart = requiredNamedToken(alternative, "ELSE_IF");
      branches.push({
        introducer: requiredToken(alternative, "then"),
        startsAt: alternativeStart.span.start,
        body: fieldRules(alternative, "consequence"),
      });
    }
    const fallback = optionalRule(body, "fallback");
    if (fallback !== null) {
      const fallbackStart = requiredToken(fallback, "else");
      branches.push({
        introducer: fallbackStart,
        startsAt: fallbackStart.span.start,
        body: fieldRules(fallback, "alternative"),
      });
    }
  }

  for (const [index, branch] of branches.entries()) {
    if (branch.body.length === 0) {
      throw new Error(
        "An empty legacy `if` branch has no layout-suite spelling.",
      );
    }
    if (branch.introducer.text === "else") {
      replaceToken(branch.introducer, "else:", edits);
    } else {
      edits.push({
        start: precedingHorizontalWhitespace(
          source,
          branch.introducer.span.start,
        ),
        end: branch.introducer.span.end,
        text: ":",
      });
    }
    replaceGap(
      source,
      branch.introducer.span.end,
      branch.body[0].span.start,
      indent + 2,
      edits,
    );
    separateStatements(branch.body, source, indent + 2, edits);
    const next = branches[index + 1];
    const endOffset = next === undefined ? end.span.end : next.startsAt;
    if (next === undefined) {
      removeClosingGap(
        source,
        branch.body.at(-1)!.span.end,
        endOffset,
        indent,
        edits,
      );
    } else {
      replaceGap(
        source,
        branch.body.at(-1)!.span.end,
        endOffset,
        indent,
        edits,
      );
    }
  }
}

function migrateConditional(rule: Rule, source: string, edits: Edit[]): void {
  const indent = effectiveLineIndent(source, rule.span.start, edits);
  const condition = requiredRule(rule, "condition");
  const then = requiredToken(rule, "then");
  const consequence = requiredRule(rule, "consequence");
  replaceConditionalIntroducer(source, condition.span.end, then, indent, edits);
  normalizeConditionalValue(then, consequence, indent, edits);

  let previous = consequence;
  for (const alternative of fieldRules(rule, "alternatives")) {
    const elseIf = requiredNamedToken(alternative, "ELSE_IF");
    replaceGap(source, previous.span.end, elseIf.span.start, indent, edits);
    if (elseIf.text !== "else if") replaceToken(elseIf, "else if", edits);
    const nestedCondition = requiredRule(alternative, "condition");
    const nestedThen = requiredToken(alternative, "then");
    const nestedConsequence = requiredRule(alternative, "consequence");
    replaceConditionalIntroducer(
      source,
      nestedCondition.span.end,
      nestedThen,
      indent,
      edits,
    );
    normalizeConditionalValue(
      nestedThen,
      nestedConsequence,
      indent,
      edits,
    );
    previous = nestedConsequence;
  }

  const fallback = requiredRule(rule, "fallback");
  const elseToken = requiredToken(fallback, "else");
  const alternative = requiredRule(fallback, "alternative");
  replaceGap(source, previous.span.end, elseToken.span.start, indent, edits);
  replaceToken(elseToken, "else:", edits);
  normalizeConditionalValue(
    elseToken,
    alternative,
    indent,
    edits,
  );
  const end = requiredToken(rule, "end");
  removeClosingGap(source, alternative.span.end, end.span.end, indent, edits);
}

function normalizeConditionalValue(
  introducer: TokenCursor,
  value: Rule,
  indent: number,
  edits: Edit[],
): void {
  if (rootRuleIs(value, "block")) return;
  edits.push({
    start: introducer.span.end,
    end: value.span.start,
    text: `\n${" ".repeat(indent + 2)}return `,
  });
}

function migrateCase(rule: Rule, source: string, edits: Edit[]): void {
  const of = requiredToken(rule, "of");
  const end = requiredToken(rule, "end");
  const arms = [requiredRule(rule, "first"), ...fieldRules(rule, "rest")];
  const indent = effectiveLineIndent(source, rule.span.start, edits);
  replaceGap(source, of.span.end, arms[0].span.start, indent + 2, edits);
  for (const arm of arms) {
    const arrow = requiredToken(arm, "=>");
    const body = requiredRule(arm, "body");
    normalizeIntroducedValue(arrow, body, source, indent + 2, edits);
    if (!containsLayoutRule(body)) {
      indentValueContinuations(body, indent + 4, source, edits);
    }
  }
  for (let index = 1; index < arms.length; index += 1) {
    const comma = tokenBetween(
      rule,
      ",",
      arms[index - 1].span.end,
      arms[index].span.start,
    );
    replaceGap(
      source,
      comma.span.start,
      arms[index].span.start,
      indent + 2,
      edits,
    );
  }
  closeNestedSuite(
    source,
    arms.at(-1)!.span.end,
    end,
    indent,
    edits,
  );
}

function normalizeAssignedValue(
  rule: Rule,
  source: string,
  edits: Edit[],
): void {
  const value = requiredRule(rule, "value");
  if (rootRuleIs(value, "block")) return;
  const operator = rule.name === "binding"
    ? requiredToken(rule, "=")
    : requiredArrowToken(rule);
  replaceWhitespace(
    source,
    operator.span.end,
    value.span.start,
    effectiveLineIndent(source, rule.span.start, edits),
    edits,
  );
}

function normalizeLambdaBody(
  rule: Rule,
  source: string,
  edits: Edit[],
): void {
  const body = requiredRule(rule, "body");
  if (rootRuleIs(body, "block")) return;
  const parameters = fieldRules(rule, "parameters");
  const lastParameter = parameters.at(-1);
  if (lastParameter === undefined) {
    throw new Error("A lambda has no parameter.");
  }
  const arrow = requiredToken(lastParameter, "=>");
  replaceWhitespace(
    source,
    arrow.span.end,
    body.span.start,
    effectiveLineIndent(source, rule.span.start, edits),
    edits,
  );
}

function normalizeIntroducedValue(
  introducer: TokenCursor,
  value: Rule,
  source: string,
  indent: number,
  edits: Edit[],
): void {
  if (rootRuleIs(value, "block")) return;
  replaceWhitespace(
    source,
    introducer.span.end,
    value.span.start,
    indent,
    edits,
  );
}

function replaceWhitespace(
  source: string,
  start: number,
  end: number,
  indent: number,
  edits: Edit[],
): void {
  const comments = source.slice(start, end).match(/\/\/[^\r\n]*/g) ?? [];
  if (comments.length === 0) {
    edits.push({ start, end, text: " " });
    return;
  }
  edits.push({
    start,
    end,
    text: ` ${comments.join(`\n${" ".repeat(indent)}`)}\n${" ".repeat(indent)}`,
  });
}

function replaceConditionalIntroducer(
  source: string,
  start: number,
  introducer: TokenCursor,
  indent: number,
  edits: Edit[],
): void {
  const comments = source.slice(start, introducer.span.start).match(
    /\/\/[^\r\n]*/g,
  ) ?? [];
  const commentText = comments.length === 0
    ? ""
    : ` ${comments.join(`\n${" ".repeat(indent)}`)}\n${" ".repeat(indent)}`;
  edits.push({
    start,
    end: introducer.span.end,
    text: `:${commentText}`,
  });
}

function rootRuleIs(rule: Rule, name: string): boolean {
  let current = rule;
  while (current.name !== name) {
    const children = current.children().filter((child): child is Rule =>
      child.type === "rule"
    );
    if (children.length !== 1) return false;
    current = children[0];
  }
  return true;
}

function migrateHandlerComposition(
  rule: Rule,
  source: string,
  edits: Edit[],
): void {
  const withToken = requiredToken(rule, "with");
  const end = requiredToken(rule, "end");
  const entries = [...fieldRules(rule, "steps"), requiredRule(rule, "result")];
  const indent = effectiveLineIndent(source, rule.span.start, edits);
  replaceGap(
    source,
    withToken.span.end,
    entries[0].span.start,
    indent + 2,
    edits,
  );
  for (let index = 1; index < entries.length; index += 1) {
    replaceGap(
      source,
      entries[index - 1].span.end,
      entries[index].span.start,
      indent + 2,
      edits,
    );
  }
  closeNestedSuite(
    source,
    entries.at(-1)!.span.end,
    end,
    indent,
    edits,
  );
}

function separateStatements(
  statements: readonly Rule[],
  source: string,
  indent: number,
  edits: Edit[],
): void {
  for (let index = 1; index < statements.length; index += 1) {
    replaceGap(
      source,
      statements[index - 1].span.end,
      statements[index].span.start,
      indent,
      edits,
    );
  }
}

function closeNestedSuite(
  source: string,
  bodyEnd: number,
  closing: TokenCursor,
  indent: number,
  edits: Edit[],
): void {
  const enclosingTerminatorIsRemoved = edits.some((edit) =>
    edit.start === closing.span.end && edit.end === closing.span.end + 1 &&
    edit.text === ""
  );
  if (enclosingTerminatorIsRemoved) {
    removeClosingGap(source, bodyEnd, closing.span.end, indent, edits);
    return;
  }
  replaceGap(source, bodyEnd, closing.span.end, indent, edits);
}

function migrateElementBody(rule: Rule, source: string, edits: Edit[]): void {
  const opening = requiredNamedToken(rule, "ANGLE_RIGHT");
  const closing = requiredNamedToken(rule, "ANGLE_CLOSE");
  const children = fieldRules(rule, "children");
  if (children.length === 0) {
    edits.push({
      start: opening.span.end,
      end: closing.span.start,
      text: "",
    });
    return;
  }
  const indent = effectiveLineIndent(source, rule.span.start, edits);
  replaceGap(
    source,
    opening.span.end,
    children[0].span.start,
    indent + 2,
    edits,
  );
  for (let index = 1; index < children.length; index += 1) {
    replaceGap(
      source,
      children[index - 1].span.end,
      children[index].span.start,
      indent + 2,
      edits,
    );
  }
  replaceGap(
    source,
    children.at(-1)!.span.end,
    closing.span.start,
    indent,
    edits,
  );
}

function replaceGap(
  source: string,
  start: number,
  end: number,
  indent: number,
  edits: Edit[],
  prefix = "",
): void {
  const comments = source.slice(start, end).match(/\/\/[^\r\n]*/g) ?? [];
  const lines = comments.map((comment) => `${" ".repeat(indent)}${comment}`);
  const commentLines = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  edits.push({
    start,
    end,
    text: `${prefix}\n${commentLines}${" ".repeat(indent)}`,
  });
}

function removeClosingGap(
  source: string,
  start: number,
  end: number,
  indent: number,
  edits: Edit[],
): void {
  const comments = source.slice(start, end).match(/\/\/[^\r\n]*/g) ?? [];
  let text = "";
  if (comments.length > 0) {
    text = `\n${
      comments.map((comment) => `${" ".repeat(indent + 2)}${comment}`).join(
        "\n",
      )
    }`;
  }
  edits.push({ start, end, text });
}

function lineIndent(source: string, offset: number): number {
  const lineStart = Math.max(
    source.lastIndexOf("\n", offset - 1),
    source.lastIndexOf("\r", offset - 1),
  ) + 1;
  let width = 0;
  for (const character of source.slice(lineStart, offset)) {
    if (character === " ") width += 1;
    else if (character === "\t") width += 8 - (width % 8);
    else break;
  }
  return width;
}

function effectiveLineIndent(
  source: string,
  offset: number,
  edits: readonly Edit[],
): number {
  let joinedBy: Edit | null = null;
  for (const edit of edits) {
    if (edit.end > offset || edit.text.includes("\n")) continue;
    if (!source.slice(edit.start, edit.end).includes("\n")) continue;
    if (source.slice(edit.end, offset).includes("\n")) continue;
    if (joinedBy === null || edit.end > joinedBy.end) joinedBy = edit;
  }
  if (joinedBy !== null) {
    return effectiveLineIndent(source, joinedBy.start, edits);
  }
  return lineIndent(source, offset);
}

function precedingHorizontalWhitespace(source: string, offset: number): number {
  let start = offset;
  while (
    start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")
  ) {
    start -= 1;
  }
  return start;
}

function directToken(rule: Rule, text: string): TokenCursor | null {
  for (const child of rule.children()) {
    if (child.type === "token" && child.text === text) return child;
  }
  return null;
}

function requiredToken(rule: Rule, text: string): TokenCursor {
  const token = directToken(rule, text);
  if (token === null) throw new Error(`${rule.name} has no \`${text}\` token.`);
  return token;
}

function requiredArrowToken(rule: Rule): TokenCursor {
  for (const child of rule.children()) {
    if (
      child.type === "token" &&
      (child.text === ":=" || child.text === "<-")
    ) return child;
  }
  throw new Error(`${rule.name} has no rebinding arrow.`);
}

function requiredNamedToken(rule: Rule, kind: string): TokenCursor {
  for (const child of rule.children()) {
    if (child.type === "token" && child.kind === kind) return child;
  }
  throw new Error(`${rule.name} has no ${kind} token.`);
}

function tokenBetween(
  rule: Rule,
  text: string,
  start: number,
  end: number,
): TokenCursor {
  for (const child of rule.children()) {
    if (
      child.type === "token" && child.text === text &&
      child.span.start >= start && child.span.end <= end
    ) return child;
  }
  throw new Error(
    `${rule.name} has no \`${text}\` between ${start} and ${end}.`,
  );
}

function replaceToken(token: TokenCursor, text: string, edits: Edit[]): void {
  edits.push({ start: token.span.start, end: token.span.end, text });
}

function requiredRule(rule: Rule, name: string): Rule {
  const value = optionalRule(rule, name);
  if (value === null) throw new Error(`${rule.name} has no ${name}.`);
  return value;
}

function optionalRule(rule: Rule, name: string): Rule | null {
  const value = rule.field(name);
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    throw new Error(`${rule.name}.${name} is repeated.`);
  }
  if ((value as Cursor).type !== "rule") {
    throw new Error(`${rule.name}.${name} is a token.`);
  }
  return value as Rule;
}

function fieldRules(rule: Rule, name: string): Rule[] {
  const value = rule.field(name);
  if (value === null || value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry): entry is Rule =>
    entry !== null && entry !== undefined && (entry as Cursor).type === "rule"
  );
}

function applyEdits(source: string, edits: readonly Edit[]): string {
  const ordered = [...edits].sort((left, right) =>
    left.start - right.start || left.end - right.end
  );
  const chunks: string[] = [];
  let cursor = 0;
  let previous: Edit | null = null;
  for (const edit of ordered) {
    if (edit.start < cursor) {
      throw new Error(
        `Migration edits ${previous?.start}..${previous?.end} and ${edit.start}..${edit.end} overlap near ${
          JSON.stringify(source.slice(edit.start, edit.end))
        }.`,
      );
    }
    chunks.push(source.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
    previous = edit;
  }
  chunks.push(source.slice(cursor));
  return chunks.join("");
}

function semanticTree(module: Module): string {
  return JSON.stringify(normalizeModuleValue(module));
}

function normalizeModuleValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeModuleValue);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object" || value === null) return value;

  const record = value as Record<string, unknown>;
  if (
    record.tag === "block" && Array.isArray(record.declarations) &&
    record.declarations.length === 0
  ) {
    return normalizeModuleValue(record.result);
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(record)) {
    if (key === "span") continue;
    if (key === "name" && typeof field === "string") {
      normalized[key] = field.replace(/\$[0-9]+/g, "$span");
      continue;
    }
    normalized[key] = normalizeModuleValue(field);
  }
  return normalized;
}

function firstDifference(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return length;
}
