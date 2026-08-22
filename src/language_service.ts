import { fromFileUrl, resolve } from "@std/path";
import { Compiler, type CompilerAnalysis } from "./compiler.ts";
import { BlotError } from "./diagnostic.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { LoadError } from "./load.ts";
import type { Span } from "./syntax/ast.ts";
import { parse, parseConcrete } from "./syntax/parse.ts";
import { definitionAt } from "./tooling/definition.ts";
import { formatSource } from "./tooling/formatter.ts";
import { hoverAt } from "./tooling/hover.ts";
import { lineAtOffset, sourceLineStarts } from "./tooling/formatter.ts";
import { lintModule } from "./tooling/lint.ts";
import type { LintDiagnostic } from "./tooling/lint.ts";

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
  readonly severity: 1 | 2 | 4;
  readonly code: string;
  readonly source: "blot";
  readonly message: string;
}

export interface Location {
  readonly uri: string;
  readonly range: Range;
}

export interface Hover {
  readonly contents: {
    readonly kind: "markdown";
    readonly value: string;
  };
  readonly range: Range;
}

export interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}

export interface CodeAction {
  readonly title: string;
  readonly kind: "quickfix";
  readonly diagnostics: readonly LanguageDiagnostic[];
  readonly edit: {
    readonly documentChanges: readonly [{
      readonly textDocument: {
        readonly uri: string;
        readonly version: number;
      };
      readonly edits: readonly TextEdit[];
    }];
  };
}

interface OpenDocument {
  readonly source: string;
  readonly version: number;
}

export class LanguageService {
  readonly #documents = new Map<string, OpenDocument>();
  readonly #hoverChecks = new Map<
    string,
    {
      readonly version: number;
      readonly checked: Promise<CompilerAnalysis | null>;
    }
  >();
  readonly #compiler: Promise<Compiler>;

  constructor() {
    this.#compiler = Compiler.create();
  }

  open(uri: string, source: string, version: number): void {
    this.#documents.set(uri, { source, version });
    this.#hoverChecks.delete(uri);
  }

  change(uri: string, source: string, version: number): void {
    if (!this.#documents.has(uri)) {
      throw new Error(`cannot change unopened document ${uri}`);
    }
    this.#documents.set(uri, { source, version });
    this.#hoverChecks.delete(uri);
  }

  close(uri: string): void {
    this.#documents.delete(uri);
    this.#hoverChecks.delete(uri);
  }

  version(uri: string): number | null {
    const document = this.#documents.get(uri);
    if (document === undefined) return null;
    return document.version;
  }

  async diagnostics(uri: string): Promise<readonly LanguageDiagnostic[]> {
    const document = this.#requiredDocument(uri);
    const parsed = await parseConcrete(document.source);
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
    for (const diagnostic of await this.#validatedLints(uri, parsed)) {
      diagnostics.push(languageDiagnostic(
        document.source,
        diagnostic,
        diagnostic.severity === "warning" ? 2 : 4,
      ));
    }
    return diagnostics;
  }

  async codeActions(
    uri: string,
    range: Range,
  ): Promise<readonly CodeAction[]> {
    const document = this.#requiredDocument(uri);
    const parsed = await parseConcrete(document.source);
    if (!parsed.ok) return [];
    const requestedStart = offsetAtPosition(document.source, range.start);
    const requestedEnd = offsetAtPosition(document.source, range.end);
    const actions: CodeAction[] = [];
    for (
      const diagnostic of await this.#validatedLints(uri, parsed)
    ) {
      if (diagnostic.fix === null) continue;
      if (
        requestedEnd < diagnostic.span.start ||
        requestedStart > diagnostic.span.end
      ) continue;
      const editSpan = diagnostic.fix.span;
      const replacement = document.source.slice(0, editSpan.start) +
        diagnostic.fix.replacement +
        document.source.slice(editSpan.end);
      if (!(await parse(replacement)).ok) continue;
      const language = languageDiagnostic(
        document.source,
        diagnostic,
        diagnostic.severity === "warning" ? 2 : 4,
      );
      actions.push({
        title: diagnostic.fix.title,
        kind: "quickfix",
        diagnostics: [language],
        edit: {
          documentChanges: [{
            textDocument: { uri, version: document.version },
            edits: [{
              range: rangeOf(document.source, editSpan),
              newText: diagnostic.fix.replacement,
            }],
          }],
        },
      });
    }
    return actions;
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

  async hover(uri: string, position: Position): Promise<Hover | null> {
    const document = this.#requiredDocument(uri);
    const parsed = await parseConcrete(document.source);
    if (!parsed.ok) return null;
    const checked = await this.#typedRevision(uri, document);
    const offset = offsetAtPosition(document.source, position);
    const description = hoverAt(
      parsed.module,
      document.source,
      parsed.cst,
      offset,
      checked,
    );
    if (description === null) return null;
    return {
      contents: { kind: "markdown", value: description.markdown },
      range: rangeOf(document.source, description.span),
    };
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
    this.#hoverChecks.clear();
  }

  #typedRevision(
    uri: string,
    document: OpenDocument,
  ): Promise<CompilerAnalysis | null> {
    const cached = this.#hoverChecks.get(uri);
    if (cached !== undefined && cached.version === document.version) {
      return cached.checked;
    }
    const path = filePath(uri) ?? resolve(".blot-untitled.blot");
    const checked = this.#compiler.then((compiler) =>
      compiler.analyzeSource(path, document.source)
    ).catch((error) => {
      if (
        error instanceof BlotError || error instanceof LoadError ||
        error instanceof Deno.errors.NotFound
      ) return null;
      throw error;
    });
    this.#hoverChecks.set(uri, { version: document.version, checked });
    return checked;
  }

  async #validatedLints(
    uri: string,
    parsed: Extract<
      Awaited<ReturnType<typeof parseConcrete>>,
      { readonly ok: true }
    >,
  ): Promise<readonly LintDiagnostic[]> {
    const document = this.#requiredDocument(uri);
    const diagnostics = lintModule(parsed.module, document.source, parsed.cst);
    if (
      !diagnostics.some((diagnostic) =>
        diagnostic.fix !== null && diagnostic.fix.validation !== "parse"
      )
    ) return diagnostics;
    const path = filePath(uri);
    if (path === null) {
      return diagnostics.filter((diagnostic) =>
        diagnostic.fix === null || diagnostic.fix.validation === "parse"
      );
    }
    const compiler = await this.#compiler;
    let original;
    try {
      original = await compiler.checkSource(path, document.source);
    } catch (error) {
      if (diagnosticFromError(path, error) === null) throw error;
      return diagnostics.filter((diagnostic) =>
        diagnostic.fix === null || diagnostic.fix.validation === "parse"
      );
    }
    const validated: LintDiagnostic[] = [];
    let compilerRevisionChanged = false;
    try {
      for (const diagnostic of diagnostics) {
        const fix = diagnostic.fix;
        if (fix === null || fix.validation === "parse") {
          validated.push(diagnostic);
          continue;
        }
        const replacement = document.source.slice(0, fix.span.start) +
          fix.replacement + document.source.slice(fix.span.end);
        try {
          compilerRevisionChanged = true;
          const checked = await compiler.checkSource(path, replacement);
          if (
            fix.validation === "check" ||
            (
              checked.type === original.type &&
              checked.effects === original.effects
            )
          ) validated.push(diagnostic);
        } catch (error) {
          if (diagnosticFromError(path, error) === null) throw error;
        }
      }
    } finally {
      if (compilerRevisionChanged) {
        await compiler.checkSource(path, document.source);
      }
    }
    return validated;
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
  severity: 1 | 2 | 4,
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
