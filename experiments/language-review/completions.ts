import type { CheckedModule, Compiler } from "../../src/compiler.ts";
import type { Decl, Expr, Span } from "../../src/syntax/ast.ts";
import type { Cursor } from "../../src/syntax/cursor.ts";
import { parseConcrete } from "../../src/syntax/parse.ts";

export interface ExpressionHole {
  readonly name: string;
  readonly span: Span;
}

/**
 * Experimental source markers, not a new compiler primitive. Unreplaced
 * @hole expressions remain errors in the production compiler.
 */
export async function expressionHoles(
  source: string,
): Promise<readonly ExpressionHole[]> {
  const parsed = await parseConcrete(source);
  if (!parsed.ok) throw new SyntaxError(JSON.stringify(parsed.diagnostics));
  const holes: ExpressionHole[] = [];
  const names = new Set<string>();
  const visit = (expression: Expr): void => {
    if (
      expression.tag === "apply" && expression.fn.tag === "intrinsic" &&
      expression.fn.name === "@hole" && expression.arg.tag === "text"
    ) {
      const name = expression.arg.value;
      if (names.has(name)) {
        throw new RangeError(`Duplicate expression hole: ${name}`);
      }
      names.add(name);
      holes.push({ name, span: expression.span });
    }
  };
  for (const declaration of parsed.module.declarations) {
    walkDeclaration(declaration, visit);
  }
  walkExpression(parsed.module.result, visit);
  return holes.sort((left, right) => left.span.start - right.span.start);
}

export interface CheckedCompletion {
  readonly source: string;
  readonly checked: CheckedModule;
}

/**
 * Replace every marker and ask the real Rust/Wasm checker to validate the
 * complete program. No Bottom values, ownership exemptions, or erased effects
 * stand in for unresolved holes. Checking can execute normal compile-time code;
 * this is not an untrusted-code sandbox.
 *
 * The initial prototype accepts single-line expressions only. Each candidate
 * must remain inside the generated parentheses; comments cannot swallow the
 * surrounding source. Multi-line layout-aware replacement is intentionally not
 * guessed here.
 */
export async function checkCompletion(
  compiler: Compiler,
  path: string,
  source: string,
  replacements: ReadonlyMap<string, string>,
): Promise<CheckedCompletion> {
  const holes = await expressionHoles(source);
  if (holes.length === 0) {
    throw new RangeError("The source contains no expression holes");
  }
  const known = new Set(holes.map((hole) => hole.name));
  for (const name of replacements.keys()) {
    if (!known.has(name)) {
      throw new RangeError(`Unknown expression hole: ${name}`);
    }
  }
  let completed = source;
  for (const hole of [...holes].reverse()) {
    const candidate = replacements.get(hole.name);
    if (candidate === undefined) {
      throw new RangeError(`Unresolved expression hole: ${hole.name}`);
    }
    await validateCandidate(candidate);
    completed = completed.slice(0, hole.span.start) + `(${candidate})` +
      completed.slice(hole.span.end);
  }
  if ((await expressionHoles(completed)).length > 0) {
    throw new RangeError(
      "A replacement introduced another unresolved expression hole",
    );
  }
  const checked = await compiler.checkSource(path, completed);
  return { source: completed, checked };
}

async function validateCandidate(candidate: string): Promise<void> {
  if (/[\n\r\u2028\u2029]/u.test(candidate)) {
    throw new SyntaxError(
      "Completion candidates must be single-line expressions",
    );
  }
  const wrapped = `return (${candidate})\n`;
  const parsed = await parseConcrete(wrapped);
  if (!parsed.ok) throw new SyntaxError(JSON.stringify(parsed.diagnostics));
  const containsWrapper = (cursor: Cursor): boolean => {
    if (cursor.type === "token") return false;
    if (
      cursor.name === "parenthesized_or_tuple" && cursor.span.start === 7 &&
      cursor.span.end === wrapped.length - 1
    ) return true;
    return cursor.children().some(containsWrapper);
  };
  if (!containsWrapper(parsed.cst)) {
    throw new SyntaxError(
      "A completion must not escape its expression boundary",
    );
  }
}

function walkDeclaration(
  declaration: Decl,
  visit: (expression: Expr) => void,
): void {
  if (declaration.tag === "binding") {
    for (const tag of declaration.tags) walkExpression(tag.descriptor, visit);
  }
  walkExpression(declaration.value, visit);
}

function walkExpression(
  expression: Expr,
  visit: (expression: Expr) => void,
): void {
  visit(expression);
  switch (expression.tag) {
    case "apply":
      walkExpression(expression.fn, visit);
      walkExpression(expression.arg, visit);
      break;
    case "field":
      walkExpression(expression.target, visit);
      break;
    case "lambda":
      walkExpression(expression.body, visit);
      break;
    case "rec":
      walkExpression(expression.lambda, visit);
      break;
    case "array":
      for (const element of expression.elements) {
        walkExpression(element.value, visit);
      }
      break;
    case "tuple":
      for (const element of expression.elements) walkExpression(element, visit);
      break;
    case "shape":
      for (const member of expression.members) {
        if (member.tag === "computed") walkExpression(member.name, visit);
        walkExpression(member.value, visit);
      }
      break;
    case "if":
      for (const branch of expression.branches) {
        walkExpression(branch.condition, visit);
        walkExpression(branch.consequence, visit);
      }
      if (expression.fallback !== null) {
        walkExpression(expression.fallback, visit);
      }
      break;
    case "case":
      walkExpression(expression.target, visit);
      for (const arm of expression.arms) walkExpression(arm.body, visit);
      break;
    case "block":
      for (const declaration of expression.declarations) {
        walkDeclaration(declaration, visit);
      }
      walkExpression(expression.result, visit);
      break;
    default:
      break;
  }
}
