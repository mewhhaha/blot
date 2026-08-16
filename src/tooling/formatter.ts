import type { Diagnostic } from "../diagnostic.ts";
import { parseConcrete } from "../syntax/parse.ts";
import type { Module, Span } from "../syntax/ast.ts";

export type FormatResult =
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

type ConcreteNode =
  | {
    readonly type: "token";
    readonly kind: string;
    readonly text: string;
    readonly span: Span;
  }
  | {
    readonly type: "rule";
    readonly name: string;
    readonly span: Span;
    children(): readonly ConcreteNode[];
  };

type ConcreteToken = Extract<ConcreteNode, { readonly type: "token" }>;
type ConcreteRule = Extract<ConcreteNode, { readonly type: "rule" }>;

interface IndentRegion {
  readonly startsAtLine: number;
  readonly endsAtLine: number;
  readonly includesLastLine: boolean;
  readonly extraInteriorIndent: boolean;
}

const maximumLineWidth = 80;
const delimitedLayoutRules = new Set([
  "array",
  "effect_row",
  "parenthesized_or_tuple",
  "shape",
]);
const layoutSensitiveRules = new Set([
  "array",
  "block",
  "do_block",
  "case_expression",
  "effect_row",
  "shape",
]);
const blockRule = new Set(["block", "do_block"]);
const valueScopeBoundaryRules = new Set([
  "block",
  "do_block",
  "case_expression",
]);
const indentedValueRuleNames = new Set([
  "continued_expression",
  "lambda",
]);
const suiteStatementRules = new Set([
  "conditional_statement",
  "iteration",
]);

const INDENTED_RULES = new Set([
  "array",
  "array_pattern",
  "block",
  "case_expression",
  "effect_row",
  "lambda",
  "operator_section",
  "parenthesized_or_tuple",
  "shape",
  "shape_pattern",
  "statement_suite",
]);

/**
 * Applies Blot's deliberately small house style: two-space structural
 * indentation, no trailing whitespace, LF line endings, and one final newline.
 * Non-whitespace source content is retained, so comments never need a second
 * lexer and cannot be dropped by printing from the elaborated AST.
 */
export async function formatSource(source: string): Promise<FormatResult> {
  let parsed = await parseConcrete(source);
  if (!parsed.ok) return parsed;

  const preferredSequencing = preferDiscardSequencing(source, parsed.cst);
  if (preferredSequencing !== source) {
    const reparsed = await parseConcrete(preferredSequencing);
    if (
      reparsed.ok &&
      moduleWithoutSpans(reparsed.module) === moduleWithoutSpans(parsed.module)
    ) {
      source = preferredSequencing;
      parsed = reparsed;
    }
  }
  const redundantParentheses: Span[] = [];
  collectRedundantParentheses(parsed.cst, [], source, redundantParentheses);

  let withoutRedundantParentheses = removeParentheses(
    source,
    redundantParentheses,
  );
  if (redundantParentheses.length > 0) {
    const reparsed = await parseConcrete(withoutRedundantParentheses);
    if (
      !reparsed.ok ||
      moduleWithoutSpans(reparsed.module) !== moduleWithoutSpans(parsed.module)
    ) {
      withoutRedundantParentheses = source;
    }
  }
  withoutRedundantParentheses = await removeRedundantLambdaParentheses(
    withoutRedundantParentheses,
    parsed.module,
  );
  let laidOut = withoutRedundantParentheses.replace(
    /\n[ \t]*\n([ \t]*else\b)/g,
    "\n$1",
  );
  while (true) {
    const current = await parseConcrete(laidOut);
    if (!current.ok) break;
    const statementValue = formatOneStatementValue(laidOut, current.cst);
    if (statementValue !== laidOut) {
      laidOut = statementValue;
      continue;
    }
    const array = formatOneArray(laidOut, current.cst);
    if (array !== laidOut) {
      laidOut = array;
      continue;
    }
    const tuple = formatOneTuple(laidOut, current.cst);
    if (tuple !== laidOut) {
      laidOut = tuple;
      continue;
    }
    const lambda = formatOneLambda(laidOut, current.cst);
    if (lambda === laidOut) break;
    laidOut = lambda;
  }
  let laidOutParse = await parseConcrete(laidOut);
  if (!laidOutParse.ok) {
    laidOut = withoutRedundantParentheses;
    laidOutParse = await parseConcrete(laidOut);
  }
  if (!laidOutParse.ok) {
    throw new Error("formatter lost a previously parsed module");
  }
  if (
    moduleWithoutSpans(laidOutParse.module) !==
      moduleWithoutSpans(parsed.module)
  ) {
    laidOut = withoutRedundantParentheses;
    laidOutParse = await parseConcrete(laidOut);
    if (!laidOutParse.ok) {
      throw new Error("formatter lost a previously parsed module");
    }
  }
  const concrete = laidOutParse.cst;
  const lineStarts = sourceLineStarts(laidOut);
  const regions: IndentRegion[] = [];
  collectIndentRegions(concrete, laidOut, lineStarts, regions);
  const lines = laidOut.split("\n");
  const formatted = lines.map((line, index) => {
    const content = line.trim();
    if (content === "") return "";
    const openingLines = new Set<number>();
    let extraInteriorIndent = 0;
    for (const region of regions) {
      if (index <= region.startsAtLine) continue;
      if (index < region.endsAtLine) {
        openingLines.add(region.startsAtLine);
        if (region.extraInteriorIndent) extraInteriorIndent += 1;
      }
      if (
        index === region.endsAtLine && region.includesLastLine
      ) {
        openingLines.add(region.startsAtLine);
      }
    }
    return `${"  ".repeat(openingLines.size + extraInteriorIndent)}${content}`;
  });
  const formattedSource = separateStatementSuites(
    `${formatted.join("\n").trimEnd()}\n`,
    concrete,
    lineStarts,
  );
  const reparsed = await parseConcrete(formattedSource);
  if (
    reparsed.ok &&
    moduleWithoutSpans(reparsed.module) === moduleWithoutSpans(parsed.module)
  ) {
    return { ok: true, source: formattedSource };
  }

  const preservedLayout = `${
    lines.map((line) => line.trimEnd()).join("\n").trimEnd()
  }\n`;
  let previousIndent: number | null = null;
  const normalizedClosingLayout = preservedLayout.split("\n").map((line) => {
    const content = line.trim();
    if (content === "") return "";
    const currentIndent = line.match(/^[ ]*/)?.[0].length;
    if (currentIndent === undefined) {
      throw new Error("preserved line has no indentation");
    }
    const indent = /^[)\]}][,;]?$/.test(content) && previousIndent !== null
      ? Math.min(currentIndent, Math.max(0, previousIndent - 2))
      : currentIndent;
    previousIndent = indent;
    return `${" ".repeat(indent)}${content}`;
  }).join("\n");
  const preserved = await parseConcrete(normalizedClosingLayout);
  if (
    !preserved.ok ||
    moduleWithoutSpans(preserved.module) !== moduleWithoutSpans(parsed.module)
  ) {
    throw new Error("formatter could not preserve the parsed module");
  }
  const separatedLayout = separateStatementSuites(
    normalizedClosingLayout,
    preserved.cst,
    sourceLineStarts(normalizedClosingLayout),
  );
  const separated = await parseConcrete(separatedLayout);
  if (
    !separated.ok ||
    moduleWithoutSpans(separated.module) !== moduleWithoutSpans(parsed.module)
  ) {
    throw new Error("formatter could not separate statement suites");
  }
  return { ok: true, source: separatedLayout };
}

function formatOneStatementValue(
  source: string,
  root: ConcreteRule,
): string {
  const statements: ConcreteRule[] = [];
  collectRules(root, "binding", statements);
  collectRules(root, "result", statements);
  collectRules(root, "module_export", statements);
  statements.sort((left, right) => left.span.start - right.span.start);
  for (const statement of statements) {
    let introducer = directToken(statement, "return");
    if (statement.name === "binding") introducer = directToken(statement, "=");
    if (statement.name === "module_export") {
      introducer = directToken(statement, "export");
    }
    if (introducer === null) continue;
    let value = directRule(statement, "value");
    const indentedValue = directRule(statement, "indented_value");
    if (indentedValue !== null) value = indentedBindingValue(indentedValue);
    if (value === null) continue;
    const valueSpan = ruleContentSpan(value);
    const separator = source.slice(introducer.span.end, valueSpan.start);
    if (!/^[ \t\r\n]*$/.test(separator)) continue;
    const valueSource = source.slice(valueSpan.start, valueSpan.end);
    const statementLineStart = source.lastIndexOf(
      "\n",
      introducer.span.start - 1,
    ) + 1;
    const indent = source.slice(statementLineStart).match(/^[ \t]*/)?.[0];
    if (indent === undefined) {
      throw new Error(`${statement.name} line has no indentation`);
    }
    const valueStartsOnIntroducerLine = !separator.includes("\n");
    const valueIsMultiline = valueSource.includes("\n");
    const valueFirstLineEnd = valueSource.indexOf("\n");
    let valueFirstLine = valueSource;
    if (valueFirstLineEnd >= 0) {
      valueFirstLine = valueSource.slice(0, valueFirstLineEnd);
    }
    const inlineWidth = introducer.span.end - statementLineStart + 1 +
      valueFirstLine.length;
    let valueUsesDelimiters = false;
    const valueIsLambda = value.name === "lambda" ||
      directRule(value, "lambda") !== null;
    if (!valueUsesDelimiters && !valueIsLambda) {
      let expression = directRule(value, "expression");
      if (value.name === "continued_expression") expression = value;
      if (expression !== null) {
        let valueScopeOwnsLayout = expressionPrimaryIs(expression, "do_block");
        for (const layoutRule of valueScopeBoundaryRules) {
          if (expressionPrimaryIs(expression, layoutRule)) {
            valueScopeOwnsLayout = true;
            break;
          }
        }
        if (!valueScopeOwnsLayout) {
          valueUsesDelimiters = containsRule(expression, delimitedLayoutRules);
        }
      }
    }
    const bindingOwnsDelimitedValue = statement.name === "binding" &&
      valueIsMultiline && valueUsesDelimiters;
    const needsSeparateLine = inlineWidth > maximumLineWidth ||
      bindingOwnsDelimitedValue;
    if (!needsSeparateLine) {
      if (valueStartsOnIntroducerLine && separator === " ") continue;
      if (statement.name === "binding") continue;
      return replaceSpan(
        source,
        { start: introducer.span.end, end: valueSpan.end },
        ` ${valueSource}`,
      );
    }
    if (!valueStartsOnIntroducerLine && separator === `\n${indent}  `) {
      continue;
    }
    const valueLines = reindentFragment(
      source,
      valueSpan,
      `${indent}  `,
      "",
    );
    return replaceSpan(
      source,
      { start: introducer.span.end, end: valueSpan.end },
      `\n${valueLines.join("\n")}`,
    );
  }
  return source;
}

function indentedBindingValue(
  indentedValue: ConcreteRule,
): ConcreteRule | null {
  for (const child of indentedValue.children()) {
    if (child.type === "rule" && indentedValueRuleNames.has(child.name)) {
      return child;
    }
  }
  return null;
}

function separateStatementSuites(
  source: string,
  root: ConcreteRule,
  lineStarts: readonly number[],
): string {
  const lines = source.split("\n");
  const separators = new Set<number>();
  collectSeparators(root);

  const separated: string[] = [];
  for (let line = 0; line < lines.length; line += 1) {
    if (
      separators.has(line) && separated.at(-1)?.trim() !== ""
    ) {
      separated.push("");
    }
    const content = lines[line];
    if (content !== undefined) separated.push(content);
  }
  return separated.join("\n");

  function collectSeparators(node: ConcreteNode): void {
    if (node.type !== "rule") return;
    const siblingName = node.name === "program"
      ? "declaration"
      : blockRule.has(node.name) || node.name === "statement_suite"
      ? "statement"
      : null;
    if (siblingName !== null) {
      const siblings = directRules(node, siblingName);
      for (let index = 0; index + 1 < siblings.length; index += 1) {
        const current = siblings[index];
        const next = siblings[index + 1];
        if (
          current === undefined || next === undefined ||
          !current.children().some((child) =>
            child.type === "rule" && suiteStatementRules.has(child.name)
          )
        ) {
          continue;
        }
        let nextLine = lineAtOffset(lineStarts, next.span.start);
        const nextIndent = lines[nextLine]?.match(/^[ ]*/)?.[0];
        if (nextIndent === undefined) {
          throw new Error("following statement has no indentation");
        }
        while (
          nextLine > 0 && lines[nextLine - 1]?.trimStart().startsWith("//")
        ) {
          const comment = lines[nextLine - 1];
          if (comment === undefined) {
            throw new Error("leading comment is missing");
          }
          lines[nextLine - 1] = `${nextIndent}${comment.trimStart()}`;
          nextLine -= 1;
        }
        separators.add(nextLine);
      }
    }
    for (const child of node.children()) collectSeparators(child);
  }
}

function formatOneArray(source: string, root: ConcreteRule): string {
  const arrays: ConcreteRule[] = [];
  collectRules(root, "array", arrays);
  arrays.sort((left, right) =>
    (right.span.end - right.span.start) - (left.span.end - left.span.start)
  );
  for (const array of arrays) {
    const elements = directRules(array, "array_element");
    if (elements.length === 0) continue;
    const arraySpan = contentSpan(source, array.span);
    const original = source.slice(arraySpan.start, arraySpan.end);
    if (original.includes("//")) continue;
    const elementSources = elements.map((element) => {
      const span = contentSpan(source, element.span);
      return source.slice(span.start, span.end).trim();
    });
    if (elementSources.some((element) => element.includes("\n"))) continue;
    const lineStart = source.lastIndexOf("\n", arraySpan.start - 1) + 1;
    const lineEnd = source.indexOf("\n", arraySpan.end);
    const suffixEnd = lineEnd < 0 ? source.length : lineEnd;
    const flattened = `[${elementSources.join(", ")}]`;
    const candidateWidth = source.slice(lineStart, arraySpan.start).length +
      flattened.length + source.slice(arraySpan.end, suffixEnd).length;
    if (candidateWidth <= maximumLineWidth) {
      if (flattened === original) continue;
      return replaceSpan(source, arraySpan, flattened);
    }
    const indent = source.slice(lineStart).match(/^[ \t]*/)?.[0];
    if (indent === undefined) throw new Error("array line has no indentation");
    const nestedIndent = `${indent}  `;
    const lines = elementSources.map((element, index) => {
      const separator = index < elementSources.length - 1 ? "," : "";
      return `${nestedIndent}${element}${separator}`;
    });
    const replacement = `[\n${lines.join("\n")}\n${indent}]`;
    if (replacement === original) continue;
    return replaceSpan(source, arraySpan, replacement);
  }
  return source;
}

function formatOneTuple(source: string, root: ConcreteRule): string {
  const tuples: ConcreteRule[] = [];
  collectRules(root, "parenthesized_or_tuple", tuples);
  tuples.sort((left, right) =>
    (right.span.end - right.span.start) - (left.span.end - left.span.start)
  );
  for (const tuple of tuples) {
    const values = directRules(tuple, "value");
    if (values.length < 2) continue;
    const tupleSpan = contentSpan(source, tuple.span);
    const original = source.slice(tupleSpan.start, tupleSpan.end);
    if (
      flattenLines(original).length < maximumLineWidth / 2 ||
      original.includes("//") || original.startsWith("(\n")
    ) {
      continue;
    }
    const lineStart = source.lastIndexOf("\n", tupleSpan.start - 1) + 1;
    const lineEnd = source.indexOf("\n", tupleSpan.end);
    const suffixEnd = lineEnd < 0 ? source.length : lineEnd;
    const candidateWidth = source.slice(lineStart, tupleSpan.start).length +
      original.length + source.slice(tupleSpan.end, suffixEnd).length;
    if (!original.includes("\n") && candidateWidth <= maximumLineWidth) {
      continue;
    }
    const indent = source.slice(lineStart).match(/^[ \t]*/)?.[0];
    if (indent === undefined) throw new Error("tuple line has no indentation");
    const nestedIndent = `${indent}  `;
    const lines = values.flatMap((value, index) => {
      const separator = index < values.length - 1 ? "," : "";
      const valueSpan = contentSpan(source, value.span);
      const valueLines = [...reindentFragment(
        source,
        valueSpan,
        nestedIndent,
        "",
      )];
      const last = valueLines.length - 1;
      valueLines[last] = `${valueLines[last]}${separator}`;
      return valueLines;
    });
    return replaceSpan(
      source,
      tupleSpan,
      `(\n${lines.join("\n")}\n${indent})`,
    );
  }
  return source;
}

function formatOneLambda(source: string, root: ConcreteRule): string {
  const lambdas: ConcreteRule[] = [];
  collectRules(root, "lambda", lambdas);
  lambdas.sort((left, right) =>
    (right.span.end - right.span.start) - (left.span.end - left.span.start)
  );
  for (const lambda of lambdas) {
    const lambdaSpan = contentSpan(source, lambda.span);
    const body = directRule(lambda, "expression");
    if (body === null || expressionIsBlock(body)) continue;
    const original = source.slice(lambdaSpan.start, lambdaSpan.end);
    if (original.includes("//")) continue;
    if (original.includes("\n") && containsRule(body, layoutSensitiveRules)) {
      continue;
    }
    const flattened = flattenLines(original);
    const lineStart = source.lastIndexOf("\n", lambdaSpan.start - 1) + 1;
    const lineEnd = source.indexOf("\n", lambdaSpan.end);
    const suffixEnd = lineEnd < 0 ? source.length : lineEnd;
    const candidateWidth = source.slice(lineStart, lambdaSpan.start).length +
      flattened.length + source.slice(lambdaSpan.end, suffixEnd).length;
    if (candidateWidth <= maximumLineWidth) {
      if (flattened === original) continue;
      return replaceSpan(source, lambdaSpan, flattened);
    }
    const parameters = directRules(lambda, "lambda_parameter");
    const lastParameter = parameters.at(-1);
    if (lastParameter === undefined) continue;
    const arrow = directToken(lastParameter, "=>");
    if (arrow === null) continue;
    const indent = source.slice(lineStart).match(/^[ \t]*/)?.[0];
    if (indent === undefined) throw new Error("lambda line has no indentation");
    const bodyIndent = `${indent}  `;
    const bodySpan = contentSpan(source, body.span);
    const bodyLines = reindentFragment(
      source,
      bodySpan,
      bodyIndent,
      "return ",
    );
    const first = bodyLines[0];
    if (first === undefined || first === "") continue;
    const closesDelimited = closesDelimitedLayout(root, lambda);
    const replacement = `${
      source.slice(lambdaSpan.start, arrow.span.end)
    }\n${first}${
      bodyLines.length === 1 ? "" : `\n${bodyLines.slice(1).join("\n")}`
    }${
      closesDelimited && closesOnSameLine(source, lambdaSpan.end)
        ? `\n${indent}`
        : ""
    }`;
    return replaceSpan(source, lambdaSpan, replacement);
  }
  return source;
}

function hasAncestorIn(
  node: ConcreteNode,
  target: ConcreteRule,
  names: ReadonlySet<string>,
  ancestors: readonly ConcreteRule[] = [],
): boolean {
  if (node === target) {
    return ancestors.some((ancestor) => names.has(ancestor.name));
  }
  if (node.type !== "rule") return false;
  const nestedAncestors = [...ancestors, node];
  return node.children().some((child) =>
    hasAncestorIn(child, target, names, nestedAncestors)
  );
}

function closesDelimitedLayout(
  node: ConcreteNode,
  target: ConcreteRule,
  ancestors: readonly ConcreteRule[] = [],
): boolean {
  if (node === target) {
    for (const ancestor of ancestors.toReversed()) {
      if (delimitedLayoutRules.has(ancestor.name)) return true;
      if (blockRule.has(ancestor.name)) return false;
    }
    return false;
  }
  if (node.type !== "rule") return false;
  const nestedAncestors = [...ancestors, node];
  return node.children().some((child) =>
    closesDelimitedLayout(child, target, nestedAncestors)
  );
}

function closesOnSameLine(source: string, offset: number): boolean {
  const lineEnd = source.indexOf("\n", offset);
  const suffixEnd = lineEnd < 0 ? source.length : lineEnd;
  return source.slice(offset, suffixEnd).trim() !== "";
}

function reindentFragment(
  source: string,
  span: Span,
  indent: string,
  prefix: string,
): readonly string[] {
  const lines = source.slice(span.start, span.end).split("\n");
  const first = lines[0];
  if (first === undefined) throw new Error("source fragment has no content");
  const lineStart = source.lastIndexOf("\n", span.start - 1) + 1;
  const sourceIndent = source.slice(lineStart).match(/^[ \t]*/)?.[0];
  if (sourceIndent === undefined) {
    throw new Error("source fragment line has no indentation");
  }
  return [
    `${indent}${prefix}${first.trim()}`,
    ...lines.slice(1).map((line) => {
      const leading = line.match(/^[ \t]*/)?.[0];
      if (leading === undefined) {
        throw new Error("source fragment continuation has no indentation");
      }
      const relativeWidth = Math.max(0, leading.length - sourceIndent.length);
      return `${indent}${" ".repeat(relativeWidth)}${line.trimStart()}`;
    }),
  ];
}

function collectRules(
  node: ConcreteNode,
  name: string,
  rules: ConcreteRule[],
): void {
  if (node.type !== "rule") return;
  if (node.name === name) rules.push(node);
  for (const child of node.children()) collectRules(child, name, rules);
}

function preferDiscardSequencing(
  source: string,
  concrete: ConcreteRule,
): string {
  const bindings: ConcreteRule[] = [];
  collectRules(concrete, "rebinding", bindings);
  const discardedNames = bindings.flatMap((binding) => {
    const name = directToken(binding, "_");
    const arrow = directToken(binding, "<-");
    if (name === null || arrow === null || name.span.end > arrow.span.start) {
      return [];
    }
    if (!/^[ \t]*$/.test(source.slice(name.span.end, arrow.span.start))) {
      return [];
    }
    return [{ start: name.span.start, end: arrow.span.start }];
  }).sort((left, right) => right.start - left.start);

  let preferred = source;
  for (const discardedName of discardedNames) {
    preferred = replaceSpan(preferred, discardedName, "");
  }
  return preferred;
}

function containsRule(
  node: ConcreteNode,
  names: ReadonlySet<string>,
): boolean {
  if (node.type !== "rule") return false;
  if (names.has(node.name)) return true;
  return node.children().some((child) => containsRule(child, names));
}

function expressionIsBlock(expression: ConcreteRule): boolean {
  return expressionPrimaryIs(expression, "block") ||
    expressionPrimaryIs(expression, "do_block");
}

function expressionPrimaryIs(
  expression: ConcreteRule,
  name: string,
): boolean {
  const operand = directRule(expression, "operand");
  if (operand === null) return false;
  const postfix = directRule(operand, "postfix_expression");
  if (postfix === null) return false;
  const primary = directRule(postfix, "primary_expression");
  if (primary === null) return false;
  return directRule(primary, name) !== null;
}

function directToken(rule: ConcreteRule, text: string): ConcreteToken | null {
  for (const child of rule.children()) {
    if (child.type === "token" && child.text === text) return child;
  }
  return null;
}

function flattenLines(source: string): string {
  return source.replace(/[ \t]*\r?\n[ \t]*/g, " ").trim();
}

function replaceSpan(source: string, span: Span, replacement: string): string {
  return source.slice(0, span.start) + replacement + source.slice(span.end);
}

function contentSpan(source: string, span: Span): Span {
  let end = span.end;
  while (end > span.start && /\s/.test(source[end - 1])) end -= 1;
  return { start: span.start, end };
}

function ruleContentSpan(rule: ConcreteRule): Span {
  let end = rule.span.start;
  collectContentEnd(rule);
  return { start: rule.span.start, end };

  function collectContentEnd(node: ConcreteNode): void {
    if (node.type === "token") {
      if (!/^[\uE000-\uF8FF]+$/.test(node.text)) {
        end = Math.max(end, node.span.end);
      }
      return;
    }
    for (const child of node.children()) collectContentEnd(child);
  }
}

function collectRedundantParentheses(
  node: ConcreteNode,
  ancestors: readonly ConcreteRule[],
  source: string,
  parentheses: Span[],
): void {
  if (node.type !== "rule") return;
  if (
    node.name === "parenthesized_or_tuple" &&
    !parenthesizesLambda(node) &&
    source.slice(node.span.start, node.span.end).indexOf("\n") < 0 &&
    parenthesesAreRedundant(node, ancestors)
  ) {
    parentheses.push(node.span);
  }
  const nestedAncestors = [...ancestors, node];
  for (const child of node.children()) {
    collectRedundantParentheses(child, nestedAncestors, source, parentheses);
  }
}

async function removeRedundantLambdaParentheses(
  source: string,
  expectedModule: Module,
): Promise<string> {
  let current = source;
  let candidates: Span[] = [];
  while (true) {
    const parsed = await parseConcrete(current);
    if (!parsed.ok) {
      throw new Error("lambda parenthesis removal received invalid source");
    }
    candidates = [];
    collectCandidates(parsed.cst, []);
    candidates.sort((left, right) =>
      (left.end - left.start) - (right.end - right.start)
    );
    let removed = false;
    for (const candidate of candidates) {
      const trial = removeParentheses(current, [candidate]);
      const reparsed = await parseConcrete(trial);
      if (
        !reparsed.ok ||
        moduleWithoutSpans(reparsed.module) !==
          moduleWithoutSpans(expectedModule)
      ) {
        continue;
      }
      current = trial;
      removed = true;
      break;
    }
    if (!removed) return current;
  }

  function collectCandidates(
    node: ConcreteNode,
    ancestors: readonly ConcreteRule[],
  ): void {
    if (node.type !== "rule") return;
    if (
      node.name === "parenthesized_or_tuple" &&
      parenthesizesLambda(node) &&
      parenthesesAreRedundant(node, ancestors)
    ) {
      candidates.push(node.span);
    }
    const nestedAncestors = [...ancestors, node];
    for (const child of node.children()) {
      collectCandidates(child, nestedAncestors);
    }
  }
}

function parenthesesAreRedundant(
  grouping: ConcreteRule,
  ancestors: readonly ConcreteRule[],
): boolean {
  if (
    grouping.children().some((child) =>
      child.type === "token" && child.text === ","
    )
  ) {
    return false;
  }
  const value = directRule(grouping, "value");
  if (value === null) return false;
  if (directRule(value, "lambda") !== null) {
    const outerPostfixIndex = findLastRule(ancestors, "postfix_expression");
    if (outerPostfixIndex < 0) return true;
    const pathFromPostfix = ancestors.slice(outerPostfixIndex + 1);
    const groupingIsApplicationHead = pathFromPostfix.some((ancestor) =>
      ancestor.name === "primary_expression"
    );
    if (!groupingIsApplicationHead) return true;
    const outerPostfix = ancestors[outerPostfixIndex];
    return directRules(outerPostfix, "application_argument").length === 0 &&
      directRules(outerPostfix, "field_suffix").length === 0;
  }
  const expression = directRule(value, "expression");
  if (expression === null) return false;
  if (directRules(expression, "infix_operation").length > 0) return false;

  const operand = directRule(expression, "operand");
  if (operand === null) return false;
  if (directRules(operand, "prefix_operator").length > 0) return false;
  const postfix = directRule(operand, "postfix_expression");
  if (postfix === null || !hasApplicationPrimary(postfix)) return false;

  const innerApplications = directRules(postfix, "application_argument");
  if (innerApplications.length === 0) return true;

  const outerPostfixIndex = findLastRule(ancestors, "postfix_expression");
  if (outerPostfixIndex < 0) return true;
  if (
    ancestors.slice(outerPostfixIndex + 1).some((ancestor) =>
      ancestor.name === "application_argument"
    )
  ) return false;
  const outerPostfix = ancestors[outerPostfixIndex];
  return directRules(outerPostfix, "field_suffix").length === 0;
}

function parenthesizesLambda(grouping: ConcreteRule): boolean {
  const value = directRule(grouping, "value");
  return value !== null && directRule(value, "lambda") !== null;
}

function hasApplicationPrimary(postfix: ConcreteRule): boolean {
  const primary = directRule(postfix, "primary_expression");
  if (primary === null) return false;
  const inner = primary.children()[0];
  if (inner === undefined) return false;
  if (inner.type === "token") {
    return inner.kind === "IDENT" || inner.kind === "TYPE_IDENT" ||
      inner.kind === "INTEGER" || inner.kind === "FLOAT" ||
      inner.kind === "TEXT" || inner.kind === "INTRINSIC";
  }
  return inner.name === "constructor_expression" || inner.name === "unit" ||
    inner.name === "array" || inner.name === "shape" ||
    inner.name === "parenthesized_or_tuple";
}

function directRule(
  rule: ConcreteRule,
  name: string,
): ConcreteRule | null {
  const found = directRules(rule, name);
  if (found.length === 0) return null;
  return found[0];
}

function directRules(
  rule: ConcreteRule,
  name: string,
): readonly ConcreteRule[] {
  return rule.children().filter((child): child is ConcreteRule =>
    child.type === "rule" && child.name === name
  );
}

function findLastRule(
  rules: readonly ConcreteRule[],
  name: string,
): number {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    if (rules[index].name === name) return index;
  }
  return -1;
}

function removeParentheses(
  source: string,
  parentheses: readonly Span[],
): string {
  const removed = new Set<number>();
  for (const span of parentheses) {
    if (source[span.start] !== "(" || source[span.end - 1] !== ")") {
      throw new Error(
        `parenthesized source ${span.start}..${span.end} lost its delimiters`,
      );
    }
    removed.add(span.start);
    removed.add(span.end - 1);
    const closingLineStart = source.lastIndexOf("\n", span.end - 2) + 1;
    if (
      closingLineStart > span.start &&
      source.slice(closingLineStart, span.end - 1).trim() === ""
    ) {
      for (let index = closingLineStart - 1; index < span.end; index += 1) {
        removed.add(index);
      }
    }
  }
  const characters: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (!removed.has(index)) characters.push(source[index]);
  }
  return characters.join("");
}

function moduleWithoutSpans(module: Module): string {
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

function lastCodeLine(
  source: string,
  lineStarts: readonly number[],
  line: number,
  limit: number,
): number {
  let current = line;
  while (current > limit) {
    const start = lineStarts[current];
    if (start === undefined) return current;
    const end = lineStarts[current + 1] ?? source.length;
    const content = source.slice(start, end).trim();
    if (content !== "" && !content.startsWith("//")) return current;
    current -= 1;
  }
  return current;
}

function collectIndentRegions(
  node: ConcreteNode,
  source: string,
  lineStarts: readonly number[],
  regions: IndentRegion[],
  ancestors: readonly ConcreteRule[] = [],
): void {
  if (node.type !== "rule") return;
  if (node.name === "binding") {
    const indentedValue = directRule(node, "indented_value");
    let value: ConcreteRule | null = null;
    if (indentedValue !== null) value = indentedBindingValue(indentedValue);
    if (value !== null) {
      const equals = directToken(node, "=");
      if (equals === null) throw new Error("binding has no equals token");
      const startsAtLine = lineAtOffset(lineStarts, equals.span.start);
      const endsAtLine = lineAtOffset(
        lineStarts,
        Math.max(value.span.start, ruleContentSpan(value).end - 1),
      );
      if (startsAtLine < endsAtLine) {
        regions.push({
          startsAtLine,
          endsAtLine,
          includesLastLine: true,
          extraInteriorIndent: false,
        });
      }
    }
  }
  if (node.name === "result" || node.name === "module_export") {
    const value = directRule(node, "value");
    if (value !== null) {
      const startsAtLine = lineAtOffset(lineStarts, node.span.start);
      const valueStartsAtLine = lineAtOffset(lineStarts, value.span.start);
      const endsAtLine = lineAtOffset(
        lineStarts,
        Math.max(value.span.start, ruleContentSpan(value).end - 1),
      );
      if (startsAtLine < valueStartsAtLine && startsAtLine < endsAtLine) {
        regions.push({
          startsAtLine,
          endsAtLine,
          includesLastLine: true,
          extraInteriorIndent: false,
        });
      }
    }
  }
  if (node.name === "do_block") {
    const startsAtLine = lineAtOffset(lineStarts, node.span.start);
    const endsAtLine = lineAtOffset(
      lineStarts,
      Math.max(node.span.start, ruleContentSpan(node).end - 1),
    );
    if (startsAtLine < endsAtLine) {
      regions.push({
        startsAtLine,
        endsAtLine,
        includesLastLine: true,
        extraInteriorIndent: false,
      });
    }
  }
  if (INDENTED_RULES.has(node.name)) {
    let startsAtLine = lineAtOffset(lineStarts, node.span.start);
    if (
      (node.name === "block" || node.name === "statement_suite") &&
      startsAtLine > 0
    ) {
      startsAtLine -= 1;
    }
    const contentEnd = node.name === "lambda" || node.name === "block" ||
        node.name === "operator_section"
      ? ruleContentSpan(node).end
      : node.span.end;
    // A suite's span runs to the dedent, so it can cover the blank line and
    // the comment that introduce whatever follows. Ending the region at the
    // last line carrying code keeps a comment block at the indentation of the
    // statement it belongs to, rather than indenting its first line into a
    // scope the reader has left and leaving the rest behind.
    const endsAtLine = lastCodeLine(
      source,
      lineStarts,
      lineAtOffset(lineStarts, Math.max(node.span.start, contentEnd - 1)),
      lineAtOffset(lineStarts, node.span.start),
    );
    if (startsAtLine < endsAtLine) {
      let closesEffectValue = false;
      if (node.name === "parenthesized_or_tuple") {
        for (const ancestor of ancestors.toReversed()) {
          if (
            ancestor.name === "rebinding" || ancestor.name === "sequencing"
          ) {
            closesEffectValue = directToken(ancestor, "<-") !== null;
            break;
          }
          if (
            delimitedLayoutRules.has(ancestor.name) ||
            blockRule.has(ancestor.name) || ancestor.name === "lambda"
          ) {
            break;
          }
        }
      }
      const opensInsideSameLineScope = delimitedLayoutRules.has(node.name) &&
        ancestors.some((ancestor) =>
          INDENTED_RULES.has(ancestor.name) &&
          ancestor.name !== "block" && ancestor.name !== "statement_suite" &&
          lineAtOffset(lineStarts, ancestor.span.start) === startsAtLine
        );
      regions.push({
        startsAtLine,
        endsAtLine,
        includesLastLine: node.name === "block" || node.name === "lambda" ||
          closesEffectValue,
        extraInteriorIndent: closesEffectValue || opensInsideSameLineScope,
      });
    }
  }
  const nestedAncestors = [...ancestors, node];
  for (const child of node.children()) {
    collectIndentRegions(child, source, lineStarts, regions, nestedAncestors);
  }
}

export function sourceLineStarts(source: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

export function lineAtOffset(
  lineStarts: readonly number[],
  offset: number,
): number {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle;
  }
  return low;
}
