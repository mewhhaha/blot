import type { Decl, Expr, Pattern, Span } from "../../syntax/ast.ts";
import { patternNames } from "../../syntax/ast.ts";

export function spanKey(span: Span): string {
  return `${span.start}:${span.end}`;
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
      return expression.members.some((member) =>
        expressionReads(member.value, names)
      );
    case "if":
      return expression.branches.some((branch) =>
        expressionReads(branch.condition, names) ||
        expressionReads(branch.consequence, names)
      ) ||
        (expression.fallback !== null &&
          expressionReads(expression.fallback, names));
    case "case":
      if (expressionReads(expression.target, names)) return true;
      return expression.arms.some((arm) =>
        expressionReads(arm.body, without(names, patternNames(arm.pattern)))
      );
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
  for (const declaration of declarations) {
    if (expressionReads(declaration.value, visible)) return true;
    if (declaration.tag === "binding") {
      for (const tag of declaration.tags) {
        if (expressionReads(tag.descriptor, visible)) return true;
      }
    }
    visible = without(visible, declarationNames(declaration));
    if (visible.size === 0) return false;
  }
  return expressionReads(result, visible);
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
