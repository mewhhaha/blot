import type { Diagnostic } from "../diagnostic.ts";
import type { Rule } from "./cursor.ts";

interface TokenCursor {
  readonly type: "token";
  readonly kind: string;
  readonly text: string;
  readonly span: { readonly start: number; readonly end: number };
}

type Cursor = Rule | TokenCursor;

interface ScopeLayer {
  readonly frame: number;
  readonly names: Set<string>;
}

interface Scope {
  readonly layers: ScopeLayer[];
}

interface Validation {
  readonly diagnostics: Diagnostic[];
  nextFrame: number;
}

export function rebindingFrameDiagnostics(root: Rule): readonly Diagnostic[] {
  const validation: Validation = { diagnostics: [], nextFrame: 0 };
  const scope = newFrame(null, validation);

  const header = cursorField(root, "header");
  if (header !== null && header.type === "rule") {
    const parameter = cursorField(header, "parameter");
    bindNames(scope, boundPatternNames(parameter));
  }

  visitStatements(fieldList(root, "declarations"), scope, validation);
  return validation.diagnostics;
}

function newFrame(parent: Scope | null, validation: Validation): Scope {
  validation.nextFrame += 1;
  const layers = parent === null ? [] : [...parent.layers];
  layers.push({ frame: validation.nextFrame, names: new Set() });
  return { layers };
}

function childScope(parent: Scope): Scope {
  const frame = parent.layers.at(-1)?.frame;
  if (frame === undefined) throw new Error("rebinding scope has no frame");
  return {
    layers: [...parent.layers, { frame, names: new Set() }],
  };
}

function bindNames(scope: Scope, names: readonly string[]): void {
  const layer = scope.layers.at(-1);
  if (layer === undefined) throw new Error("rebinding scope has no layer");
  for (const name of names) layer.names.add(name);
}

/**
 * Whether the name is bound at all, in any frame.
 *
 * A `:=` on a name nothing ever introduced is unbound, not misframed, and
 * saying so is the checker's job. Reporting the frame rule there would answer
 * a program's root cause with advice — `let missing = missing` — that is
 * unbound in its own right.
 */
function visible(scope: Scope, name: string): boolean {
  return scope.layers.some((layer) => layer.names.has(name));
}

function rebindable(scope: Scope, name: string): boolean {
  const frame = scope.layers.at(-1)?.frame;
  if (frame === undefined) return false;
  for (let index = scope.layers.length - 1; index >= 0; index -= 1) {
    const layer = scope.layers[index];
    if (layer.frame !== frame) break;
    if (layer.names.has(name)) return true;
  }
  return false;
}

function visitStatements(
  cursors: readonly Cursor[],
  scope: Scope,
  validation: Validation,
): void {
  for (const cursor of cursors) {
    const rule = statementRule(cursor);
    visitStatement(rule, scope, validation);
  }
}

function visitStatement(
  rule: Rule,
  scope: Scope,
  validation: Validation,
): void {
  if (rule.name === "binding") {
    for (const tagCursor of fieldList(rule, "tags")) {
      if (tagCursor.type !== "rule") continue;
      const descriptor = cursorField(tagCursor, "descriptor");
      if (descriptor !== null) visitCursor(descriptor, scope, validation);
    }
    const value = cursorField(rule, "value");
    if (value !== null) visitCursor(value, scope, validation);
    const kind = tokenText(cursorField(rule, "kind"));
    if (kind === "let" || kind === "const") {
      bindNames(scope, boundPatternNames(cursorField(rule, "pattern")));
    }
    return;
  }

  if (rule.name === "rebinding") {
    const value = cursorField(rule, "value");
    if (value !== null) visitCursor(value, scope, validation);
    const name = tokenText(cursorField(rule, "name"));
    const arrow = tokenText(cursorField(rule, "arrow"));
    if (name === null || arrow === null) return;
    if (arrow === "<-") {
      bindNames(scope, [name]);
      return;
    }
    if (arrow === ":=" && visible(scope, name) && !rebindable(scope, name)) {
      validation.diagnostics.push({
        code: "BLOT_REBINDING_FRAME",
        message:
          `\`${name} := ...\` requires a binding introduced in this rebinding frame. Start a local lineage with \`let ${name} = ${name}\` before rebinding it.`,
        span: rule.span,
      });
    }
    return;
  }

  if (rule.name === "conditional_statement") {
    visitConditionalStatement(rule, scope, validation);
    return;
  }

  if (rule.name === "iteration") {
    visitIteration(rule, scope, validation);
    return;
  }

  for (const name of ["value", "head", "source"] as const) {
    const value = cursorField(rule, name);
    if (value !== null) visitCursor(value, scope, validation);
  }
}

function visitConditionalStatement(
  rule: Rule,
  scope: Scope,
  validation: Validation,
): void {
  const bodyCursor = cursorField(rule, "body");
  if (bodyCursor === null || bodyCursor.type !== "rule") return;
  const body = bodyCursor;

  if (body.name === "conditional_statement_guard") {
    const value = cursorField(body, "value");
    if (value !== null) visitCursor(value, scope, validation);
    const alternative = statementSuite(body, "alternative");
    visitStatements(alternative, childScope(scope), validation);
    bindNames(scope, boundPatternNames(cursorField(body, "pattern")));
    return;
  }

  const condition = cursorField(body, "condition");
  if (condition !== null) visitCursor(condition, scope, validation);
  visitStatements(
    statementSuite(body, "consequence"),
    childScope(scope),
    validation,
  );

  for (const cursor of fieldList(body, "alternatives")) {
    if (cursor.type !== "rule") continue;
    const clauseCondition = cursorField(cursor, "condition");
    if (clauseCondition !== null) {
      visitCursor(clauseCondition, scope, validation);
    }
    visitStatements(
      statementSuite(cursor, "consequence"),
      childScope(scope),
      validation,
    );
  }

  const fallback = cursorField(body, "fallback");
  if (fallback !== null && fallback.type === "rule") {
    visitStatements(
      statementSuite(fallback, "alternative"),
      childScope(scope),
      validation,
    );
  }
}

function visitIteration(
  rule: Rule,
  scope: Scope,
  validation: Validation,
): void {
  const head = cursorField(rule, "head");
  const drawn = cursorField(rule, "drawn");
  const bodyScope = childScope(scope);

  if (drawn === null) {
    if (head !== null) visitCursor(head, scope, validation);
  } else {
    bindNames(bodyScope, boundExpressionNames(head));
    if (drawn.type === "rule") {
      const source = cursorField(drawn, "source");
      if (source !== null) visitCursor(source, scope, validation);
    }
  }

  visitStatements(statementSuite(rule, "body"), bodyScope, validation);
}

function visitCursor(
  cursor: Cursor,
  scope: Scope,
  validation: Validation,
): void {
  if (cursor.type === "token") return;
  const rule = cursor;

  if (rule.name === "lambda") {
    let frame = scope;
    for (const parameter of fieldList(rule, "parameters")) {
      if (parameter.type !== "rule") continue;
      frame = newFrame(frame, validation);
      bindNames(frame, boundPatternNames(cursorField(parameter, "pattern")));
    }
    const body = cursorField(rule, "body");
    if (body !== null) visitFrameBody(body, frame, validation);
    return;
  }

  if (rule.name === "do_block" || rule.name === "block") {
    const frame = newFrame(scope, validation);
    visitStatements(fieldList(rule, "statements"), frame, validation);
    return;
  }

  if (rule.name === "case_expression") {
    const target = cursorField(rule, "target");
    if (target !== null) visitCursor(target, scope, validation);
    const arms = [cursorField(rule, "first"), ...fieldList(rule, "rest")];
    for (const armCursor of arms) {
      if (armCursor === null || armCursor.type !== "rule") continue;
      const frame = newFrame(scope, validation);
      bindNames(frame, boundPatternNames(cursorField(armCursor, "pattern")));
      const guard = cursorField(armCursor, "guard");
      if (guard !== null) visitCursor(guard, frame, validation);
      const body = cursorField(armCursor, "body");
      if (body !== null) visitFrameBody(body, frame, validation);
    }
    return;
  }

  for (const child of rule.children()) visitCursor(child, scope, validation);
}

function visitFrameBody(
  cursor: Cursor,
  frame: Scope,
  validation: Validation,
): void {
  const direct = directStatementScope(cursor);
  if (direct !== null) {
    visitStatements(fieldList(direct, "statements"), frame, validation);
    return;
  }
  visitCursor(cursor, frame, validation);
}

function directStatementScope(cursor: Cursor): Rule | null {
  let current = cursor;
  while (current.type === "rule") {
    if (current.name === "do_block" || current.name === "block") return current;
    const children = current.children().filter((child) =>
      child.type === "rule"
    );
    if (children.length !== 1) return null;
    current = children[0];
  }
  return null;
}

function statementRule(cursor: Cursor): Rule {
  if (cursor.type !== "rule") throw new Error("statement is not a rule");
  let rule = cursor;
  while (rule.name === "statement" || rule.name === "declaration") {
    const first = rule.child(0);
    if (first === undefined || first.type !== "rule") break;
    rule = first;
  }
  return rule;
}

function statementSuite(rule: Rule, name: string): readonly Cursor[] {
  const value = rule.field(name);
  if (Array.isArray(value)) return value.filter(isCursor);
  if (!isCursor(value) || value.type !== "rule") return [];
  if (value.name === "statement_suite") return fieldList(value, "statements");
  return [];
}

function boundPatternNames(cursor: Cursor | null): readonly string[] {
  if (cursor === null) return [];
  const found: string[] = [];
  collectPatternNames(cursor, found);
  return found;
}

function collectPatternNames(cursor: Cursor, found: string[]): void {
  if (cursor.type === "token") {
    if (
      (cursor.kind === "IDENT" || cursor.kind === "TYPE_IDENT") &&
      cursor.text !== "_"
    ) found.push(cursor.text);
    return;
  }

  const rule = cursor;
  if (rule.name === "binding_pattern") {
    if (tokenText(cursorField(rule, "qualifier")) === "^") return;
    const value = cursorField(rule, "value") ?? rule.child(0) ?? null;
    if (value !== null) collectPatternNames(value, found);
    return;
  }
  if (rule.name === "pattern_core") {
    const value = cursorField(rule, "value") ?? rule.child(0) ?? null;
    if (value !== null) collectPatternNames(value, found);
    return;
  }
  if (rule.name === "unit_pattern") return;
  if (rule.name === "constructor_pattern") {
    const payload = cursorField(rule, "payload");
    if (payload !== null) collectPatternNames(payload, found);
    return;
  }
  if (rule.name === "tuple_pattern") {
    const first = cursorField(rule, "first");
    if (first !== null) collectPatternNames(first, found);
    for (const rest of fieldList(rule, "rest")) {
      collectPatternNames(rest, found);
    }
    return;
  }
  if (rule.name === "array_pattern") {
    for (const element of fieldList(rule, "elements")) {
      collectPatternNames(element, found);
    }
    return;
  }
  if (rule.name === "shape_pattern") {
    for (const fieldCursor of fieldList(rule, "fields")) {
      if (fieldCursor.type !== "rule") continue;
      const values = fieldList(fieldCursor, "value");
      const explicit = [...values].reverse().find((value) =>
        value.type === "rule"
      );
      if (explicit !== undefined) {
        collectPatternNames(explicit, found);
        continue;
      }
      const name = tokenText(cursorField(fieldCursor, "name"));
      if (name !== null && name !== "_") found.push(name);
    }
    return;
  }
}

function boundExpressionNames(cursor: Cursor | null): readonly string[] {
  if (cursor === null) return [];
  const found: string[] = [];
  collectBinderExpressionNames(cursor, found);
  return found;
}

function collectBinderExpressionNames(cursor: Cursor, found: string[]): void {
  if (cursor.type === "token") {
    if (
      (cursor.kind === "IDENT" || cursor.kind === "TYPE_IDENT") &&
      cursor.text !== "_"
    ) found.push(cursor.text);
    return;
  }

  const rule = cursor;
  if (
    rule.name === "value" || rule.name === "expression" ||
    rule.name === "continued_expression" || rule.name === "operand" ||
    rule.name === "continued_operand" || rule.name === "primary_expression" ||
    rule.name === "continued_primary_expression" ||
    rule.name === "application_primary"
  ) {
    const ruleChildren = rule.children().filter((child) =>
      child.type === "rule"
    );
    if (ruleChildren.length === 1) {
      collectBinderExpressionNames(ruleChildren[0], found);
    }
    return;
  }
  if (
    rule.name === "postfix_expression" ||
    rule.name === "continued_postfix_expression"
  ) {
    const value = cursorField(rule, "value");
    if (value === null) return;
    const arguments_ = fieldList(rule, "arguments");
    if (arguments_.length === 0) {
      collectBinderExpressionNames(value, found);
      return;
    }
    const direct = directNamedRule(value, "constructor_expression");
    if (direct === null) return;
    for (const argument of arguments_) {
      if (argument.type !== "rule") continue;
      const argumentValue = cursorField(argument, "value");
      if (argumentValue !== null) {
        collectBinderExpressionNames(argumentValue, found);
      }
    }
    return;
  }
  if (rule.name === "parenthesized_or_tuple") {
    const first = cursorField(rule, "first");
    if (first !== null) collectBinderExpressionNames(first, found);
    for (const rest of fieldList(rule, "rest")) {
      collectBinderExpressionNames(rest, found);
    }
    return;
  }
  if (rule.name === "array") {
    for (const element of fieldList(rule, "elements")) {
      if (element.type !== "rule" || cursorField(element, "spread") !== null) {
        continue;
      }
      const value = cursorField(element, "value");
      if (value !== null) collectBinderExpressionNames(value, found);
    }
    return;
  }
  if (rule.name === "shape") {
    for (const memberCursor of fieldList(rule, "members")) {
      const member =
        memberCursor.type === "rule" && memberCursor.name === "shape_member"
          ? directRuleChild(memberCursor)
          : memberCursor;
      if (
        member === null || member.type !== "rule" ||
        member.name !== "shape_field"
      ) continue;
      const value = cursorField(member, "value");
      if (value !== null) collectBinderExpressionNames(value, found);
    }
  }
}

function directNamedRule(cursor: Cursor, name: string): Rule | null {
  let current = cursor;
  while (current.type === "rule") {
    if (current.name === name) return current;
    const child = directRuleChild(current);
    if (child === null) return null;
    current = child;
  }
  return null;
}

function directRuleChild(rule: Rule): Cursor | null {
  const children = rule.children().filter((child) => child.type === "rule");
  return children.length === 1 ? children[0] : null;
}

function cursorField(rule: Rule, name: string): Cursor | null {
  const value = rule.field(name);
  if (isCursor(value)) return value;
  if (Array.isArray(value)) {
    return value.findLast(isCursor) ?? null;
  }
  return null;
}

function fieldList(rule: Rule, name: string): readonly Cursor[] {
  const value = rule.field(name);
  if (Array.isArray(value)) return value.filter(isCursor);
  return isCursor(value) ? [value] : [];
}

function tokenText(cursor: Cursor | null): string | null {
  if (cursor === null) return null;
  if (cursor.type === "token") return cursor.text;
  let current: Cursor | undefined = cursor;
  while (current !== undefined && current.type === "rule") {
    current = current.child(0);
  }
  return current?.type === "token" ? current.text : null;
}

function isCursor(value: unknown): value is Cursor {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const type = (value as { readonly type?: unknown }).type;
  return type === "rule" || type === "token";
}
