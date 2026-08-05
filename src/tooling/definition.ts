import type { Decl, Expr, Module, Pattern, Span } from "../syntax/ast.ts";
import { recursiveGroups } from "../syntax/ast.ts";

interface ReferenceSite {
  readonly span: Span;
  readonly definition: Span;
}

type Definitions = Map<string, Span>;

export function definitionAt(
  module: Module,
  source: string,
  offset: number,
): Span | null {
  const references: ReferenceSite[] = [];
  let scope: Definitions = new Map();
  if (module.parameter !== null) {
    scope = bindPattern(module.parameter, source, scope, references);
  }
  scope = visitDeclarations(
    module.declarations,
    source,
    scope,
    references,
  );
  visitExpression(module.result, source, scope, references);

  let nearest: ReferenceSite | null = null;
  for (const reference of references) {
    if (offset < reference.span.start || offset >= reference.span.end) continue;
    if (
      nearest === null ||
      reference.span.end - reference.span.start <
        nearest.span.end - nearest.span.start
    ) {
      nearest = reference;
    }
  }
  if (nearest === null) return null;
  return nearest.definition;
}

function visitDeclarations(
  declarations: readonly Decl[],
  source: string,
  initialScope: Definitions,
  references: ReferenceSite[],
): Definitions {
  let scope = new Map(initialScope);
  const recursive = recursiveGroups(declarations);
  const visitedMembers = new Set<Decl>();
  for (const declaration of declarations) {
    if (visitedMembers.has(declaration)) continue;
    const group = recursive.get(declaration);
    if (group !== undefined) {
      let groupScope = scope;
      for (const member of group) {
        groupScope = bindPattern(
          member.pattern,
          source,
          groupScope,
          references,
        );
        visitedMembers.add(member.declaration);
      }
      for (const member of group) {
        visitExpression(
          member.declaration.value,
          source,
          groupScope,
          references,
        );
        for (const tag of member.declaration.tags) {
          visitExpression(tag.descriptor, source, groupScope, references);
        }
      }
      scope = groupScope;
      continue;
    }
    visitExpression(declaration.value, source, scope, references);
    if (declaration.tag === "open") continue;
    if (declaration.tag === "shadow") {
      const span = identifierSpan(declaration.span, declaration.name, source);
      if (span === null) continue;
      scope.set(declaration.name, span);
      references.push({ span, definition: span });
      continue;
    }
    for (const tag of declaration.tags) {
      visitExpression(tag.descriptor, source, scope, references);
    }
    if (declaration.kind === "sig") continue;
    scope = bindPattern(declaration.pattern, source, scope, references);
  }
  return scope;
}

function bindPattern(
  pattern: Pattern,
  source: string,
  initialScope: Definitions,
  references: ReferenceSite[],
): Definitions {
  visitPinnedNames(pattern, source, initialScope, references);
  const scope = new Map(initialScope);
  visitBoundNames(pattern, source, (name, span) => {
    scope.set(name, span);
    references.push({ span, definition: span });
  });
  return scope;
}

function visitPinnedNames(
  pattern: Pattern,
  source: string,
  scope: Definitions,
  references: ReferenceSite[],
): void {
  if (pattern.tag === "pin") {
    const definition = scope.get(pattern.name);
    const span = identifierSpan(pattern.span, pattern.name, source);
    if (definition !== undefined && span !== null) {
      references.push({ span, definition });
    }
    return;
  }
  if (pattern.tag === "tuple" || pattern.tag === "array") {
    for (const element of pattern.elements) {
      visitPinnedNames(element, source, scope, references);
    }
    return;
  }
  if (pattern.tag === "constructor" && pattern.payload !== null) {
    visitPinnedNames(pattern.payload, source, scope, references);
    return;
  }
  if (pattern.tag === "shape") {
    for (const field of pattern.fields) {
      visitPinnedNames(field.pattern, source, scope, references);
    }
  }
}

function visitBoundNames(
  pattern: Pattern,
  source: string,
  visit: (name: string, span: Span) => void,
): void {
  if (pattern.tag === "name") {
    const span = identifierSpan(pattern.span, pattern.name, source);
    if (span !== null) visit(pattern.name, span);
    return;
  }
  if (pattern.tag === "tuple" || pattern.tag === "array") {
    for (const element of pattern.elements) {
      visitBoundNames(element, source, visit);
    }
    return;
  }
  if (pattern.tag === "constructor" && pattern.payload !== null) {
    visitBoundNames(pattern.payload, source, visit);
    return;
  }
  if (pattern.tag === "shape") {
    for (const field of pattern.fields) {
      visitBoundNames(field.pattern, source, visit);
    }
  }
}

function visitExpression(
  expression: Expr,
  source: string,
  scope: Definitions,
  references: ReferenceSite[],
): void {
  if (expression.tag === "var") {
    const definition = scope.get(expression.name);
    const span = identifierSpan(expression.span, expression.name, source);
    if (definition !== undefined && span !== null) {
      references.push({ span, definition });
    }
    return;
  }
  switch (expression.tag) {
    case "apply":
      visitExpression(expression.fn, source, scope, references);
      visitExpression(expression.arg, source, scope, references);
      return;
    case "field":
      visitExpression(expression.target, source, scope, references);
      return;
    case "lambda": {
      const bodyScope = bindPattern(
        expression.parameter,
        source,
        scope,
        references,
      );
      visitExpression(expression.body, source, bodyScope, references);
      return;
    }
    case "rec":
      visitExpression(expression.lambda, source, scope, references);
      return;
    case "comptime":
      visitExpression(expression.body, source, scope, references);
      return;
    case "tuple":
      for (const element of expression.elements) {
        visitExpression(element, source, scope, references);
      }
      return;
    case "array":
      for (const element of expression.elements) {
        visitExpression(element.value, source, scope, references);
      }
      return;
    case "shape":
      for (const member of expression.members) {
        visitExpression(member.value, source, scope, references);
      }
      return;
    case "if":
      for (const branch of expression.branches) {
        visitExpression(branch.condition, source, scope, references);
        visitExpression(branch.consequence, source, scope, references);
      }
      if (expression.fallback !== null) {
        visitExpression(expression.fallback, source, scope, references);
      }
      return;
    case "case":
      visitExpression(expression.target, source, scope, references);
      for (const arm of expression.arms) {
        const armScope = bindPattern(
          arm.pattern,
          source,
          scope,
          references,
        );
        visitExpression(arm.body, source, armScope, references);
      }
      return;
    case "block": {
      const blockScope = visitDeclarations(
        expression.declarations,
        source,
        scope,
        references,
      );
      visitExpression(expression.result, source, blockScope, references);
      return;
    }
    default:
      return;
  }
}

function identifierSpan(
  containing: Span,
  name: string,
  source: string,
): Span | null {
  const text = source.slice(containing.start, containing.end);
  let relative = text.indexOf(name);
  while (relative >= 0) {
    const start = containing.start + relative;
    const end = start + name.length;
    if (
      !isIdentifierCharacter(source[start - 1]) &&
      !isIdentifierCharacter(source[end])
    ) return { start, end };
    relative = text.indexOf(name, relative + name.length);
  }
  return null;
}

function isIdentifierCharacter(character: string | undefined): boolean {
  if (character === undefined) return false;
  return /[A-Za-z0-9_]/.test(character);
}
