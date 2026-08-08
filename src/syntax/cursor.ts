import type { Span } from "./ast.ts";
import { expect, fail } from "../diagnostic.ts";

// A structural view of baba's cursors. The generated types are a union of one
// interface per rule, which is exactly wrong for generic traversal: every
// helper here walks rules it cannot name in advance. Narrowing happens on
// `name`, so the precise types would be re-widened immediately anyway.

export interface TokenCursor {
  readonly type: "token";
  readonly kind: string;
  readonly text: string;
  readonly span: Span;
}

export interface Rule {
  readonly type: "rule";
  readonly name: string;
  readonly span: Span;
  child(index: number): Cursor | undefined;
  children(): readonly Cursor[];
  field(name: string): unknown;
}

export type Cursor = Rule | TokenCursor;

export function isRule(cursor: Cursor): cursor is Rule {
  return cursor.type === "rule";
}

export function asRule(cursor: Cursor | null | undefined, name: string): Rule {
  expect(cursor !== null && cursor !== undefined, `missing ${name}`);
  expect(isRule(cursor), `expected rule ${name}, found a token`);
  return cursor;
}

export function field(rule: Rule, name: string): Cursor | null {
  const value = rule.field(name);
  if (value === undefined || value === null) return null;
  expect(!Array.isArray(value), `field ${name} of ${rule.name} is an array`);
  return value as Cursor;
}

export function required(rule: Rule, name: string): Cursor {
  const value = field(rule, name);
  expect(value !== null, `${rule.name} has no ${name}`);
  return value;
}

export function fieldList(rule: Rule, name: string): readonly Cursor[] {
  const value = rule.field(name);
  if (value === undefined || value === null) return [];
  expect(Array.isArray(value), `field ${name} of ${rule.name} is not an array`);
  // An optional separated list — `(array_element % ",")?` — yields one empty
  // slot when it matched nothing, rather than no slots. The hole is the
  // information "there were none", so dropping it is reading the field, not
  // defaulting past a missing one. `[]` and `()` are the two forms that hit it.
  return (value as readonly (Cursor | null)[]).filter((entry) =>
    entry !== null && entry !== undefined
  ) as readonly Cursor[];
}

/** Descends through wrapper rules — `value`, `pattern_core`, `field_name` — to a token. */
export function tokenOf(cursor: Cursor): TokenCursor {
  let current = cursor;
  while (isRule(current)) {
    const first = current.child(0);
    expect(first !== undefined, `rule ${current.name} has no child`);
    current = first;
  }
  return current;
}

/** Unwraps a rule that exists only to name an alternation. */
export function unwrap(cursor: Cursor): Cursor {
  expect(isRule(cursor), "expected a rule to unwrap");
  const first = cursor.child(0);
  expect(first !== undefined, `rule ${cursor.name} has no child`);
  return first;
}

export function textOf(source: string, span: Span): string {
  return source.slice(span.start, span.end);
}

export function decodeText(literal: string, span: Span): string {
  const body = literal.slice(1, -1);
  let result = "";
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "\\") {
      result += body[index];
      continue;
    }
    index += 1;
    const escape = body[index];
    if (escape === "n") result += "\n";
    else if (escape === "t") result += "\t";
    else if (escape === "r") result += "\r";
    else if (escape === '"') result += '"';
    else if (escape === "\\") result += "\\";
    else fail("BLOT_BAD_ESCAPE", `Unknown escape \`\\${escape}\`.`, span);
  }
  return result;
}
