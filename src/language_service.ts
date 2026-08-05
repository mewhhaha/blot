import { fromFileUrl, resolve } from "@std/path";
import { Compiler } from "./compiler.ts";
import { BlotError } from "./diagnostic.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { LoadError } from "./load.ts";
import type { Span } from "./syntax/ast.ts";
import { parse } from "./syntax/parse.ts";
import { definitionAt } from "./tooling/definition.ts";
import { formatSource } from "./tooling/formatter.ts";
import { lineAtOffset, sourceLineStarts } from "./tooling/formatter.ts";
import { lintModule } from "./tooling/lint.ts";

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface LanguageDiagnostic {
  readonly range: Range;
  readonly severity: 1 | 4;
  readonly code: string;
  readonly source: "blot";
  readonly message: string;
}

export interface Location {
  readonly uri: string;
  readonly range: Range;
}

export interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}

interface OpenDocument {
  readonly source: string;
  readonly version: number;
}

export class LanguageService {
  readonly #documents = new Map<string, OpenDocument>();
  readonly #compiler: Promise<Compiler>;

  constructor() {
    this.#compiler = Compiler.create();
  }

  open(uri: string, source: string, version: number): void {
    this.#documents.set(uri, { source, version });
  }

  change(uri: string, source: string, version: number): void {
    if (!this.#documents.has(uri)) {
      throw new Error(`cannot change unopened document ${uri}`);
    }
    this.#documents.set(uri, { source, version });
  }

  close(uri: string): void {
    this.#documents.delete(uri);
  }

  version(uri: string): number | null {
    const document = this.#documents.get(uri);
    if (document === undefined) return null;
    return document.version;
  }

  async diagnostics(uri: string): Promise<readonly LanguageDiagnostic[]> {
    const document = this.#requiredDocument(uri);
    const parsed = await parse(document.source);
    if (!parsed.ok) {
      return parsed.diagnostics.map((diagnostic) =>
        languageDiagnostic(document.source, diagnostic, 1)
      );
    }

    const diagnostics: LanguageDiagnostic[] = [];
    const path = filePath(uri);
    if (path !== null) {
      try {
        await (await this.#compiler).checkSource(path, document.source);
      } catch (error) {
        const semantic = diagnosticFromError(path, error);
        if (semantic !== null) {
          diagnostics.push(languageDiagnostic(document.source, semantic, 1));
        } else {
          throw error;
        }
      }
    }
    for (const diagnostic of lintModule(parsed.module, document.source)) {
      diagnostics.push(languageDiagnostic(document.source, diagnostic, 4));
    }
    return diagnostics;
  }

  async definition(
    uri: string,
    position: Position,
  ): Promise<Location | null> {
    const document = this.#requiredDocument(uri);
    const parsed = await parse(document.source);
    if (!parsed.ok) return null;
    const offset = offsetAtPosition(document.source, position);
    const span = definitionAt(parsed.module, document.source, offset);
    if (span === null) return null;
    return { uri, range: rangeOf(document.source, span) };
  }

  async formatting(uri: string): Promise<readonly TextEdit[]> {
    const document = this.#requiredDocument(uri);
    const formatted = await formatSource(document.source);
    if (!formatted.ok || formatted.source === document.source) return [];
    return [{
      range: {
        start: { line: 0, character: 0 },
        end: positionAtOffset(document.source, document.source.length),
      },
      newText: formatted.source,
    }];
  }

  async destroy(): Promise<void> {
    (await this.#compiler).destroy();
    this.#documents.clear();
  }

  #requiredDocument(uri: string): OpenDocument {
    const document = this.#documents.get(uri);
    if (document === undefined) throw new Error(`document ${uri} is not open`);
    return document;
  }
}

function diagnosticFromError(path: string, error: unknown): Diagnostic | null {
  if (error instanceof LoadError) {
    const diagnostic = error.diagnostics[0];
    if (diagnostic === undefined) return null;
    if (resolve(error.path) === resolve(path)) return diagnostic;
    return {
      ...diagnostic,
      message: `${error.path}: ${diagnostic.message}`,
      span: { start: 0, end: 0 },
    };
  }
  if (!(error instanceof BlotError)) return null;
  if (error.origin !== null && resolve(error.origin.path) !== resolve(path)) {
    return {
      ...error.diagnostic,
      message: `${error.origin.path}: ${error.diagnostic.message}`,
      span: { start: 0, end: 0 },
    };
  }
  return error.diagnostic;
}

function languageDiagnostic(
  source: string,
  diagnostic: Diagnostic,
  severity: 1 | 4,
): LanguageDiagnostic {
  return {
    range: rangeOf(source, diagnostic.span),
    severity,
    code: diagnostic.code,
    source: "blot",
    message: diagnostic.message,
  };
}

export function rangeOf(source: string, span: Span): Range {
  return {
    start: positionAtOffset(source, span.start),
    end: positionAtOffset(source, span.end),
  };
}

export function positionAtOffset(source: string, offset: number): Position {
  const lineStarts = sourceLineStarts(source);
  const boundedOffset = Math.max(0, Math.min(offset, source.length));
  const line = lineAtOffset(lineStarts, boundedOffset);
  return { line, character: boundedOffset - lineStarts[line] };
}

export function offsetAtPosition(source: string, position: Position): number {
  const lineStarts = sourceLineStarts(source);
  const line = Math.max(0, Math.min(position.line, lineStarts.length - 1));
  let lineEnd = source.indexOf("\n", lineStarts[line]);
  if (lineEnd < 0) lineEnd = source.length;
  return Math.min(lineStarts[line] + Math.max(0, position.character), lineEnd);
}

function filePath(uri: string): string | null {
  const parsed = new URL(uri);
  if (parsed.protocol !== "file:") return null;
  return fromFileUrl(parsed);
}
