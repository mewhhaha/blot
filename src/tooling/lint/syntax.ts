import type { Decl, Expr, Pattern, Span } from "../../syntax/ast.ts";
import { patternNames, recursiveGroups } from "../../syntax/ast.ts";
import { field, fieldList, isRule, type Rule } from "../../syntax/cursor.ts";

export function spanKey(span: Span): string {
  return `${span.start}:${span.end}`;
}

export function trailingWhitespace(source: string, span: Span): string {
  const match = /\s*$/.exec(source.slice(span.start, span.end));
  if (match === null || match[0] === undefined) return "";
  return match[0];
}

export function lineComments(source: string): readonly string[] {
  return inspectSource(source).comments.map((comment) => comment.text);
}

export function sourceCodeSpan(source: string, span: Span): Span {
  const inspected = inspectSource(source.slice(span.start, span.end));
  return { start: span.start, end: span.start + inspected.codeEnd };
}

export function sourceEditSpan(source: string, span: Span): Span {
  const inspected = inspectSource(source.slice(span.start, span.end));
  const trailingComment = inspected.comments.find((comment) =>
    comment.start >= inspected.codeEnd
  );
  let end = span.end;
  if (trailingComment !== undefined) end = span.start + trailingComment.start;
  return { start: span.start, end };
}

function inspectSource(
  source: string,
): {
  readonly comments: readonly {
    readonly start: number;
    readonly text: string;
  }[];
  readonly codeEnd: number;
} {
  const comments: { readonly start: number; readonly text: string }[] = [];
  let codeEnd = 0;
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '"') {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        const textCharacter = source[index];
        index += 1;
        if (textCharacter === '"') break;
      }
      codeEnd = index;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      const start = index;
      index += 2;
      while (
        index < source.length && source[index] !== "\n" &&
        source[index] !== "\r"
      ) index += 1;
      comments.push({ start, text: source.slice(start, index) });
      continue;
    }
    index += 1;
    if (character === undefined || /\s/.test(character)) continue;
    codeEnd = index;
  }
  return { comments, codeEnd };
}

export function fieldRule(rule: Rule, name: string): Rule | null {
  const value = field(rule, name);
  if (value === null || !isRule(value)) return null;
  return value;
}

export function fieldRules(rule: Rule, name: string): readonly Rule[] {
  return fieldList(rule, name).filter(isRule);
}

export function directRule(rule: Rule, name: string): Rule | null {
  for (const child of rule.children()) {
    if (isRule(child) && child.name === name) return child;
  }
  return null;
}

export function producedExpression(expression: Expr): Expr {
  let produced = expression;
  while (produced.tag === "block" && produced.declarations.length === 0) {
    produced = produced.result;
  }
  return produced;
}

export function calleePath(expression: Expr): readonly string[] | null {
  if (expression.tag === "var" || expression.tag === "intrinsic") {
    return [expression.name];
  }
  if (expression.tag !== "field") return null;
  const target = calleePath(expression.target);
  if (target === null) return null;
  return [...target, expression.name];
}

export function binaryCall(
  expression: Expr,
): { readonly callee: Expr; readonly left: Expr; readonly right: Expr } | null {
  if (expression.tag !== "apply" || expression.fn.tag !== "apply") return null;
  return {
    callee: expression.fn.fn,
    left: expression.fn.arg,
    right: expression.arg,
  };
}

export function declarationNames(declaration: Decl): readonly string[] {
  if (declaration.tag === "shadow") return [declaration.name];
  if (declaration.tag !== "binding") return [];
  return patternNames(declaration.pattern);
}

export function expressionReads(
  expression: Expr,
  names: ReadonlySet<string>,
): boolean {
  if (expression.tag === "var") return names.has(expression.name);
  switch (expression.tag) {
    case "apply":
      return expressionReads(expression.fn, names) ||
        expressionReads(expression.arg, names);
    case "field":
      return expressionReads(expression.target, names);
    case "lambda": {
      if (patternReads(expression.parameter, names)) return true;
      const visible = without(names, patternNames(expression.parameter));
      return expressionReads(expression.body, visible);
    }
    case "rec":
      return expressionReads(expression.lambda, names);
    case "tuple":
      return expression.elements.some((element) =>
        expressionReads(element, names)
      );
    case "array":
      return expression.elements.some((element) =>
        expressionReads(element.value, names)
      );
    case "shape":
      return expression.members.some((member) => {
        if (
          member.tag === "computed" &&
          expressionReads(member.name, names)
        ) return true;
        return expressionReads(member.value, names);
      });
    case "if":
      return expression.branches.some((branch) =>
        expressionReads(branch.condition, names) ||
        expressionReads(branch.consequence, names)
      ) ||
        (expression.fallback !== null &&
          expressionReads(expression.fallback, names));
    case "case":
      if (expressionReads(expression.target, names)) return true;
      return expression.arms.some((arm) => {
        if (patternReads(arm.pattern, names)) return true;
        return expressionReads(
          arm.body,
          without(names, patternNames(arm.pattern)),
        );
      });
    case "block":
      return declarationSequenceReads(
        expression.declarations,
        expression.result,
        names,
      );
    default:
      return false;
  }
}

export function declarationSequenceReads(
  declarations: readonly Decl[],
  result: Expr,
  names: ReadonlySet<string>,
): boolean {
  let visible = names;
  const groups = recursiveGroups(declarations);
  const enteredGroups = new Set<NonNullable<ReturnType<typeof groups.get>>>();
  for (const declaration of declarations) {
    const group = groups.get(declaration);
    if (group !== undefined && !enteredGroups.has(group)) {
      visible = without(
        visible,
        group.map((member) => member.name),
      );
      enteredGroups.add(group);
      if (visible.size === 0) return false;
    }
    if (expressionReads(declaration.value, visible)) return true;
    if (declaration.tag === "binding") {
      if (patternReads(declaration.pattern, visible)) return true;
      for (const tag of declaration.tags) {
        if (expressionReads(tag.descriptor, visible)) return true;
      }
    }
    if (group === undefined) {
      visible = without(visible, declarationNames(declaration));
    }
    if (visible.size === 0) return false;
  }
  return expressionReads(result, visible);
}

function patternReads(
  pattern: Pattern,
  names: ReadonlySet<string>,
): boolean {
  switch (pattern.tag) {
    case "pin":
      return names.has(pattern.name);
    case "tuple":
    case "array":
      return pattern.elements.some((element) => patternReads(element, names));
    case "constructor":
      return pattern.payload !== null && patternReads(pattern.payload, names);
    case "shape":
      return pattern.fields.some((field) => patternReads(field.pattern, names));
    default:
      return false;
  }
}

export function patternKey(pattern: Pattern): string | null {
  switch (pattern.tag) {
    case "wildcard":
    case "name":
      return "*";
    case "int":
      return `int:${pattern.value}`;
    case "float":
      return `float:${pattern.value}`;
    case "text":
      return `text:${pattern.value}`;
    case "unit":
      return "unit";
    case "constructor": {
      if (pattern.payload === null) return `constructor:${pattern.name}`;
      const payload = patternKey(pattern.payload);
      if (payload === null) return null;
      return `constructor:${pattern.name}(${payload})`;
    }
    case "tuple":
    case "array": {
      const elements = pattern.elements.map(patternKey);
      if (elements.some((element) => element === null)) return null;
      return `${pattern.tag}:${elements.join(",")}`;
    }
    case "shape": {
      const fields = pattern.fields.map((field) => {
        const value = patternKey(field.pattern);
        if (value === null) return null;
        return `${field.name}:${value}`;
      });
      if (fields.some((field) => field === null)) return null;
      return `shape:${fields.join(",")}`;
    }
    case "pin":
      return null;
  }
}

function without(
  names: ReadonlySet<string>,
  hidden: readonly string[],
): ReadonlySet<string> {
  if (hidden.length === 0) return names;
  const result = new Set(names);
  for (const name of hidden) result.delete(name);
  return result;
}
