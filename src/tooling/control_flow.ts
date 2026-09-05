import type { Decl, Expr, Module, Span } from "../syntax/ast.ts";
import type { Cursor, Rule, TokenCursor } from "../syntax/cursor.ts";

export interface ControlFlowDescription {
  readonly markdown: string;
  readonly span: Span;
  readonly target: Span;
}

/** Syntax-only source navigation. Baba supplies the CST; no source is reparsed. */
export function controlFlowAt(
  module: Module,
  source: string,
  cst: Rule,
  offset: number,
): ControlFlowDescription | null {
  const path = pathAt(cst, offset);
  if (path === null) return null;
  const token = path.at(-1);
  if (token === undefined || token.type !== "token") return null;
  const rules = path.filter((cursor): cursor is Rule => cursor.type === "rule");
  const owner = rules.at(-1);
  if (owner === undefined) return null;

  if (owner.name === "iteration" && token.text === "for") {
    const carried = loopAccumulator(module, owner.span);
    let detail = "Accumulator information was not retained in lowered syntax.";
    if (carried !== null) {
      detail = "This loop carries no outer bindings.";
      if (carried.length > 0) {
        detail = `Loop accumulator: ${
          carried.map((name) => `\`${name}\``).join(", ")
        }.`;
      }
    }
    return {
      markdown: `**for** — iteration lowered to a fold.\n\n${detail}`,
      span: token.span,
      target: token.span,
    };
  }

  if (owner.name === "result" && token.text === "return") {
    for (const rule of rules.slice(0, -1).reverse()) {
      if (rule.name === "do_block") {
        const target = firstToken(rule);
        if (target === null) return null;
        return {
          markdown: `**return** — supplies the result of \`do\` on line ${
            lineAt(source, target.span.start)
          }.`,
          span: token.span,
          target: target.span,
        };
      }
      // An invalid or incomplete lambda must not appear to return from its
      // enclosing module merely because its explicit result scope is missing.
      if (rule.name === "lambda" || rule.name === "bounded_lambda") return null;
    }
    return {
      markdown: "**return** — supplies the result of the nearest module (this module).",
      span: token.span,
      target: { start: module.span.start, end: module.span.start },
    };
  }

  if (owner.name === "breaking" && token.text === "break") {
    for (const rule of rules.slice(0, -1).reverse()) {
      if (rule.name === "iteration") {
        const target = firstToken(rule);
        if (target === null) return null;
        return {
          markdown: `**break** — exits \`for\` on line ${
            lineAt(source, target.span.start)
          } with its current accumulator.`,
          span: token.span,
          target: target.span,
        };
      }
      if (
        rule.name === "do_block" || rule.name === "lambda" ||
        rule.name === "bounded_lambda" || rule.name === "case_expression"
      ) return null;
    }
  }
  return null;
}

/**
 * Read the accumulator actually emitted by surface lowering instead of
 * reimplementing binding, guard, and shadowing rules in the editor. `loop$`
 * and `iter$` are unspellable lowering names, scoped by the source loop span.
 */
export function loopAccumulator(
  module: Module,
  span: Span,
): readonly string[] | null {
  let retained = false;
  let carried: readonly string[] = [];
  const visitDeclaration = (declaration: Decl): void => {
    if (
      declaration.tag === "binding" &&
      declaration.span.start === span.start && declaration.span.end === span.end
    ) {
      if (
        declaration.pattern.tag === "name" &&
        declaration.pattern.name === "iter$"
      ) {
        retained = true;
      }
      if (
        declaration.value.tag === "var" && declaration.value.name === "loop$" &&
        declaration.pattern.tag === "shape"
      ) {
        carried = declaration.pattern.fields.map((field) => field.name);
      }
    }
    visitExpression(declaration.value);
    if (declaration.tag === "binding") {
      for (const tag of declaration.tags) visitExpression(tag.descriptor);
    }
  };
  const visitExpression = (expression: Expr): void => {
    switch (expression.tag) {
      case "apply":
        visitExpression(expression.fn);
        visitExpression(expression.arg);
        break;
      case "field":
        visitExpression(expression.target);
        break;
      case "lambda":
        visitExpression(expression.body);
        break;
      case "rec":
        visitExpression(expression.lambda);
        break;
      case "array":
        for (const element of expression.elements) {
          visitExpression(element.value);
        }
        break;
      case "tuple":
        for (const element of expression.elements) visitExpression(element);
        break;
      case "shape":
        for (const member of expression.members) {
          if (member.tag === "computed") visitExpression(member.name);
          visitExpression(member.value);
        }
        break;
      case "if":
        for (const branch of expression.branches) {
          visitExpression(branch.condition);
          visitExpression(branch.consequence);
        }
        if (expression.fallback !== null) visitExpression(expression.fallback);
        break;
      case "case":
        visitExpression(expression.target);
        for (const arm of expression.arms) visitExpression(arm.body);
        break;
      case "block":
        for (const declaration of expression.declarations) {
          visitDeclaration(declaration);
        }
        visitExpression(expression.result);
        break;
      default:
        break;
    }
  };
  for (const declaration of module.declarations) visitDeclaration(declaration);
  visitExpression(module.result);
  if (!retained) return null;
  return carried;
}

function pathAt(cursor: Cursor, offset: number): readonly Cursor[] | null {
  if (offset < cursor.span.start || offset >= cursor.span.end) return null;
  if (cursor.type === "token") return [cursor];
  for (const child of cursor.children()) {
    const path = pathAt(child, offset);
    if (path !== null) return [cursor, ...path];
  }
  return null;
}

function firstToken(cursor: Cursor): TokenCursor | null {
  if (cursor.type === "token") return cursor;
  for (const child of cursor.children()) {
    const token = firstToken(child);
    if (token !== null) return token;
  }
  return null;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}
