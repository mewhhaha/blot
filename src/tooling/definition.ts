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
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    if (declaration === undefined) continue;
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
    if (declaration.tag === "signature") {
      const following = declarations[index + 1];
      if (
        following?.tag === "binding" && following.pattern.tag === "name" &&
        following.pattern.name === declaration.name
      ) {
        const signatureName = identifierSpan(
          declaration.span,
          declaration.name,
          source,
        );
        const bindingName = identifierSpan(
          following.pattern.span,
          following.pattern.name,
          source,
        );
        if (signatureName !== null && bindingName !== null) {
          references.push({ span: signatureName, definition: bindingName });
        }
      }
      continue;
    }
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
    scope = bindPattern(declaration.pattern, source, scope, references);
  }
  return scope;
}

export function fieldDefinitionAt(
  module: Module,
  source: string,
  offset: number,
): Span | null {
  const field = fieldExpressionAt(module, source, offset);
  if (field === null || field.target.tag !== "var") return null;
  const target = definitionAt(module, source, field.target.span.start);
  if (target === null) return null;
  const declaration = declarationInSequence(
    module.declarations,
    source,
    target,
  );
  if (declaration === null) return null;
  return attachedMemberDefinition(declaration.value, field.name, source);
}

export function signatureTypeAt(
  module: Module,
  source: string,
  offset: number,
): Expr | null {
  const definition = definitionAt(module, source, offset);
  if (definition === null) return null;
  return signatureForDefinition(module.declarations, source, definition);
}

export function signatureTypeContaining(
  module: Module,
  offset: number,
): Expr | null {
  return containingSignature(module.declarations, offset);
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

function fieldExpressionAt(
  module: Module,
  source: string,
  offset: number,
): Extract<Expr, { readonly tag: "field" }> | null {
  const matches: Array<Extract<Expr, { readonly tag: "field" }>> = [];
  const visit = (expression: Expr): void => {
    if (offset < expression.span.start || offset >= expression.span.end) return;
    if (expression.tag === "field") {
      const name = fieldNameSpan(expression, source);
      if (name !== null && offset >= name.start && offset < name.end) {
        matches.push(expression);
      }
    }
    visitExpressionValues(expression, visit);
  };
  for (const declaration of module.declarations) visit(declaration.value);
  visit(module.result);
  matches.sort((left, right) =>
    (left.span.end - left.span.start) - (right.span.end - right.span.start)
  );
  const match = matches[0];
  if (match === undefined) return null;
  return match;
}

function fieldNameSpan(
  expression: Extract<Expr, { readonly tag: "field" }>,
  source: string,
): Span | null {
  const suffix = source.slice(expression.target.span.end, expression.span.end);
  const relative = suffix.lastIndexOf(expression.name);
  if (relative < 0) return null;
  const start = expression.target.span.end + relative;
  return { start, end: start + expression.name.length };
}

function declarationInSequence(
  declarations: readonly Decl[],
  source: string,
  definition: Span,
): Decl | null {
  for (const declaration of declarations) {
    if (declarationDefines(declaration, source, definition)) return declaration;
    const nested = declarationInExpression(
      declaration.value,
      source,
      definition,
    );
    if (nested !== null) return nested;
  }
  return null;
}

function declarationInExpression(
  expression: Expr,
  source: string,
  definition: Span,
): Decl | null {
  if (expression.tag === "block") {
    const declaration = declarationInSequence(
      expression.declarations,
      source,
      definition,
    );
    if (declaration !== null) return declaration;
  }
  let found: Decl | null = null;
  visitExpressionValues(expression, (child) => {
    if (found !== null) return;
    found = declarationInExpression(child, source, definition);
  });
  return found;
}

function declarationDefines(
  declaration: Decl,
  source: string,
  definition: Span,
): boolean {
  if (declaration.tag === "shadow") {
    const name = identifierSpan(declaration.span, declaration.name, source);
    return sameSpan(name, definition);
  }
  if (declaration.tag !== "binding") return false;
  let found = false;
  visitBoundNames(declaration.pattern, source, (_name, span) => {
    if (sameSpan(span, definition)) found = true;
  });
  return found;
}

function attachedMemberDefinition(
  expression: Expr,
  name: string,
  source: string,
): Span | null {
  if (expression.tag === "shape") {
    for (const member of expression.members) {
      if (member.tag !== "field" || member.name !== name) continue;
      const prefix = source.slice(
        expression.span.start,
        member.value.span.start,
      );
      const relative = prefix.lastIndexOf(`.${name}`);
      if (relative < 0) return null;
      const start = expression.span.start + relative + 1;
      return { start, end: start + name.length };
    }
    return null;
  }
  if (
    expression.tag !== "apply" || expression.arg.tag !== "shape" ||
    expression.fn.tag !== "apply" || expression.fn.fn.tag !== "var" ||
    expression.fn.fn.name !== "attach"
  ) return null;
  const attached = attachedMemberDefinition(expression.arg, name, source);
  if (attached !== null) return attached;
  return attachedMemberDefinition(expression.fn.arg, name, source);
}

function signatureForDefinition(
  declarations: readonly Decl[],
  source: string,
  definition: Span,
): Expr | null {
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    if (declaration === undefined) continue;
    if (declarationDefines(declaration, source, definition)) {
      const signature = declarations[index - 1];
      if (
        signature?.tag === "signature" && declaration.tag === "binding" &&
        declaration.pattern.tag === "name" &&
        signature.name === declaration.pattern.name
      ) return signature.value;
      return null;
    }
    const nested = signatureInExpression(declaration.value, source, definition);
    if (nested !== null) return nested;
  }
  return null;
}

function signatureInExpression(
  expression: Expr,
  source: string,
  definition: Span,
): Expr | null {
  if (expression.tag === "block") {
    const signature = signatureForDefinition(
      expression.declarations,
      source,
      definition,
    );
    if (signature !== null) return signature;
  }
  let found: Expr | null = null;
  visitExpressionValues(expression, (child) => {
    if (found !== null) return;
    found = signatureInExpression(child, source, definition);
  });
  return found;
}

function containingSignature(
  declarations: readonly Decl[],
  offset: number,
): Expr | null {
  for (const declaration of declarations) {
    if (
      declaration.tag === "signature" &&
      offset >= declaration.value.span.start &&
      offset < declaration.value.span.end
    ) return declaration.value;
    const nested = containingSignatureInExpression(declaration.value, offset);
    if (nested !== null) return nested;
  }
  return null;
}

function containingSignatureInExpression(
  expression: Expr,
  offset: number,
): Expr | null {
  if (expression.tag === "block") {
    const signature = containingSignature(expression.declarations, offset);
    if (signature !== null) return signature;
  }
  let found: Expr | null = null;
  visitExpressionValues(expression, (child) => {
    if (found !== null) return;
    found = containingSignatureInExpression(child, offset);
  });
  return found;
}

function visitExpressionValues(
  expression: Expr,
  visit: (expression: Expr) => void,
): void {
  switch (expression.tag) {
    case "apply":
      visit(expression.fn);
      visit(expression.arg);
      return;
    case "field":
      visit(expression.target);
      return;
    case "lambda":
      visit(expression.body);
      return;
    case "rec":
      visit(expression.lambda);
      return;
    case "tuple":
      for (const element of expression.elements) visit(element);
      return;
    case "array":
      for (const element of expression.elements) visit(element.value);
      return;
    case "shape":
      for (const member of expression.members) visit(member.value);
      return;
    case "if":
      for (const branch of expression.branches) {
        visit(branch.condition);
        visit(branch.consequence);
      }
      if (expression.fallback !== null) visit(expression.fallback);
      return;
    case "case":
      visit(expression.target);
      for (const arm of expression.arms) visit(arm.body);
      return;
    case "block":
      for (const declaration of expression.declarations) {
        visit(declaration.value);
      }
      visit(expression.result);
      return;
    default:
      return;
  }
}

function sameSpan(left: Span | null, right: Span): boolean {
  return left !== null && left.start === right.start && left.end === right.end;
}

export function identifierSpan(
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
