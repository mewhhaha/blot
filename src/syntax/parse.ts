// The parse entry point. Every compiler command hosts Baba's generated parser
// Wasm in Node, so parsing needs neither Deno nor WebGPU.

import { readFile } from "node:fs/promises";
import {
  createParser,
  type CursorFieldValue as BabaCursorFieldValue,
  type ParserInstance,
  type SyntaxCursor as BabaCursor,
} from "../../generated/wasm/mod.ts";
import type { Diagnostic } from "../diagnostic.ts";
import { BlotError } from "../diagnostic.ts";
import type { Module } from "./ast.ts";
import type { Cursor, Rule, TokenCursor } from "./cursor.ts";
import { lowerModule } from "./lower.ts";
import { elaborateLayout } from "./layout.ts";
import { rebindingFrameDiagnostics } from "./rebinding.ts";
import { elaborateSurface } from "./surface.ts";

const parserWasmUrl = new URL(
  "../../generated/wasm/parser.wasm",
  import.meta.url,
);
const planUrl = new URL("../../generated/wasm/parser.plan", import.meta.url);

let shared: ParserInstance | null = null;

async function parser(): Promise<ParserInstance> {
  if (shared !== null) return shared;
  const [bytes, plan] = await Promise.all([
    readFile(parserWasmUrl),
    readFile(planUrl),
  ]);
  shared = createParser({ bytes, plan });
  return shared;
}

export type ParseResult =
  | { readonly ok: true; readonly module: Module }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export async function parse(source: string): Promise<ParseResult> {
  const result = await parseConcrete(source);
  if (!result.ok) return result;
  const rebinding = rebindingFrameDiagnostics(result.cst);
  if (rebinding.length > 0) return { ok: false, diagnostics: rebinding };
  return { ok: true, module: result.module };
}

export type ConcreteParseResult =
  | { readonly ok: true; readonly module: Module; readonly cst: Rule }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** Parses source while retaining Baba's concrete tree for source tooling. */
export async function parseConcrete(
  source: string,
): Promise<ConcreteParseResult> {
  const elaborated = await elaborateLayout(source);
  if (!elaborated.ok) return elaborated;
  const instance = await parser();
  const result = instance.parse(elaborated.layout.source);
  if (!result.ok) {
    return {
      ok: false,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        span: remapSpan(diagnostic.span, elaborated.layout.originalOffset),
      })),
    };
  }

  try {
    const cst = materializeWasmCursor(
      result.cursor,
      elaborated.layout.originalOffset,
    );
    return {
      ok: true,
      module: elaborateSurface(lowerModule(cst, source)),
      cst,
    };
  } catch (error) {
    if (error instanceof BlotError) {
      return { ok: false, diagnostics: [error.diagnostic] };
    }
    throw error;
  }
}

function materializeWasmCursor(
  root: BabaCursor,
  originalOffset: (offset: number) => number,
): Rule {
  const rules = new WeakMap<object, Rule>();
  const tokens = new WeakMap<object, TokenCursor>();

  function wrap(cursor: BabaCursor): Cursor {
    if (cursor.type === "token") {
      const cached = tokens.get(cursor);
      if (cached !== undefined) return cached;
      const token: TokenCursor = {
        type: "token",
        kind: cursor.kind,
        text: cursor.text,
        span: remapSpan(cursor.span, originalOffset),
      };
      tokens.set(cursor, token);
      return token;
    }

    const cached = rules.get(cursor);
    if (cached !== undefined) return cached;
    const rule: Rule = {
      type: "rule",
      name: cursor.name,
      span: remapSpan(cursor.span, originalOffset),
      child(index: number): Cursor | undefined {
        const child = cursor.child(index);
        if (child === undefined) return undefined;
        return wrap(child);
      },
      children(): readonly Cursor[] {
        return cursor.children().map(wrap);
      },
      field(name: string): unknown {
        return wrapField(cursor.field(name));
      },
    };
    rules.set(cursor, rule);
    return rule;
  }

  function wrapField(value: BabaCursorFieldValue | undefined): unknown {
    if (value === undefined || value === null) return value;
    if (Array.isArray(value)) return value.map(wrapField);
    return wrap(value as BabaCursor);
  }

  const cursor = wrap(root);
  if (cursor.type !== "rule") {
    throw new Error("Baba returned a token as the root cursor");
  }
  return cursor;
}

function remapSpan(
  span: { readonly start: number; readonly end: number },
  originalOffset: (offset: number) => number,
): { readonly start: number; readonly end: number } {
  return {
    start: originalOffset(span.start),
    end: originalOffset(span.end),
  };
}

export function dispose(): void {
  if (shared === null) return;
  shared.dispose();
  shared = null;
}
