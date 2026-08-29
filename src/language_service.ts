import { readFile } from "node:fs/promises";
import { fromFileUrl, resolve, toFileUrl } from "@std/path";
import {
  Compiler,
  type CompilerAnalysis,
  type CompilerSyntaxSnapshot,
  explanationAt,
} from "./compiler.ts";
import { BlotError } from "./diagnostic.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { LoadError, resolvePath } from "./load.ts";
import type { Decl, Expr, Module, Pattern, Span } from "./syntax/ast.ts";
import { parse } from "./syntax/parse.ts";
import {
  definitionAt,
  fieldDefinitionAt,
  identifierSpan,
  signatureTypeAt,
  signatureTypeContaining,
} from "./tooling/definition.ts";
import { formatSource } from "./tooling/formatter.ts";
import { hoverAt } from "./tooling/hover.ts";
import { lineAtOffset, sourceLineStarts } from "./tooling/formatter.ts";
import { DEFAULT_LINT_RULES, lintModule } from "./tooling/lint.ts";
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

export interface CompletionItem {
  readonly label: string;
  readonly kind: 5 | 6 | 13 | 20;
  readonly detail?: string;
}

export interface SignatureHelp {
  readonly signatures: readonly [{
    readonly label: string;
    readonly parameters: readonly { readonly label: string }[];
  }];
  readonly activeSignature: 0;
  readonly activeParameter: number;
}

export interface InlayHint {
  readonly position: Position;
  readonly label: string;
  readonly kind: 1 | 2;
  readonly tooltip?: string;
  readonly paddingLeft?: boolean;
}

export interface DocumentSymbol {
  readonly name: string;
  readonly kind: 12 | 13;
  readonly range: Range;
  readonly selectionRange: Range;
  readonly detail?: string;
}

export interface WorkspaceSymbol {
  readonly name: string;
  readonly kind: 12 | 13;
  readonly location: Location;
}

export interface WorkspaceEdit {
  readonly changes: Readonly<Record<string, readonly TextEdit[]>>;
}

export interface ContentChange {
  readonly range?: Range;
  readonly rangeLength?: number;
  readonly text: string;
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
  readonly #syntaxSnapshots = new Map<
    string,
    {
      readonly version: number;
      readonly snapshot: Promise<CompilerSyntaxSnapshot>;
    }
  >();
  readonly #compiler: Promise<Compiler>;

  constructor() {
    this.#compiler = Compiler.create();
  }

  open(uri: string, source: string, version: number): void {
    this.#documents.set(uri, { source, version });
    this.#hoverChecks.delete(uri);
    this.#syntaxSnapshots.delete(uri);
  }

  change(uri: string, source: string, version: number): void {
    const current = this.#requiredDocument(uri);
    this.#requireNextVersion(uri, current.version, version);
    this.#documents.set(uri, { source, version });
    this.#hoverChecks.delete(uri);
    this.#syntaxSnapshots.delete(uri);
  }

  changeRanges(
    uri: string,
    changes: readonly ContentChange[],
    version: number,
  ): void {
    const current = this.#requiredDocument(uri);
    this.#requireNextVersion(uri, current.version, version);
    let source = current.source;
    for (const change of changes) {
      if (change.range === undefined) {
        source = change.text;
        continue;
      }
      const start = offsetAtPosition(source, change.range.start);
      const end = offsetAtPosition(source, change.range.end);
      if (end < start) {
        throw new Error(`document ${uri} change range ends before it starts`);
      }
      if (
        change.rangeLength !== undefined &&
        change.rangeLength !== end - start
      ) {
        throw new Error(
          `document ${uri} change range length ${change.rangeLength} does not match ${
            end - start
          }`,
        );
      }
      source = source.slice(0, start) + change.text + source.slice(end);
    }
    this.#documents.set(uri, { source, version });
    this.#hoverChecks.delete(uri);
    this.#syntaxSnapshots.delete(uri);
  }

  close(uri: string): void {
    this.#documents.delete(uri);
    this.#hoverChecks.delete(uri);
    this.#syntaxSnapshots.delete(uri);
  }

  version(uri: string): number | null {
    const document = this.#documents.get(uri);
    if (document === undefined) return null;
    return document.version;
  }

  async diagnostics(uri: string): Promise<readonly LanguageDiagnostic[]> {
    const document = this.#requiredDocument(uri);
    const path = editorPath(uri);
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(uri, document);
    } catch (error) {
      const diagnostic = diagnosticFromError(path, error);
      if (diagnostic !== null) {
        return [languageDiagnostic(document.source, diagnostic, 1)];
      }
      throw error;
    }

    const diagnostics: LanguageDiagnostic[] = [];
    try {
      const analysis = await (await this.#compiler).analyzeSource(
        path,
        document.source,
      );
      if (!analysis.targetPreflight.supported) {
        let message = analysis.targetPreflight.unsupportedComponent;
        if (message === null) {
          message =
            "The inferred export is not supported by the selected Wasm target.";
        }
        diagnostics.push(languageDiagnostic(document.source, {
          code: "BLOT_TARGET_REFUSAL",
          message,
          span: { start: 0, end: 0 },
        }, 1));
      }
    } catch (error) {
      const semantic = diagnosticFromError(path, error);
      if (semantic !== null) {
        diagnostics.push(languageDiagnostic(document.source, semantic, 1));
      } else {
        throw error;
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
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(uri, document);
    } catch (error) {
      if (diagnosticFromError(editorPath(uri), error) !== null) return [];
      throw error;
    }
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
    let lineEnding = "\n";
    if (document.source.includes("\r\n")) lineEnding = "\r\n";
    const signatureFacts = signatureEditorFacts(parsed.module);
    for (const correction of signatureFacts.corrections) {
      if (
        requestedEnd < correction.signatureSpan.start ||
        requestedStart > correction.signatureSpan.end
      ) continue;
      const signaturePrefix = document.source.slice(
        correction.signatureSpan.start,
        correction.valueSpan.start,
      );
      const delimiter = signaturePrefix.indexOf("::");
      if (delimiter < 0) {
        throw new Error(
          `signature at ${correction.signatureSpan.start} has no :: delimiter`,
        );
      }
      let recursive = "";
      if (correction.recursive) recursive = " rec";
      const header = `${correction.kind}${recursive} ${correction.name}`;
      actions.push({
        title: `Match signature header to \`${header}\``,
        kind: "quickfix",
        diagnostics: [],
        edit: {
          documentChanges: [{
            textDocument: { uri, version: document.version },
            edits: [{
              range: rangeOf(document.source, {
                start: correction.signatureSpan.start,
                end: correction.signatureSpan.start + delimiter,
              }),
              newText: `${header} `,
            }],
          }],
        },
      });
    }
    for (const binding of signatureFacts.bindings) {
      if (binding.hasSignature) continue;
      if (
        requestedEnd < binding.declarationSpan.start ||
        requestedStart > binding.declarationSpan.end
      ) continue;
      const lineStart = document.source.lastIndexOf(
        "\n",
        binding.declarationSpan.start - 1,
      ) + 1;
      const indentation = document.source.slice(
        lineStart,
        binding.declarationSpan.start,
      );
      let recursive = "";
      if (binding.recursive) recursive = " rec";
      actions.push({
        title: `Add inferred signature hole for \`${binding.name}\``,
        kind: "quickfix",
        diagnostics: [],
        edit: {
          documentChanges: [{
            textDocument: { uri, version: document.version },
            edits: [{
              range: rangeOf(document.source, {
                start: lineStart,
                end: lineStart,
              }),
              newText:
                `${indentation}${binding.kind}${recursive} ${binding.name} :: _${lineEnding}`,
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
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(uri, document);
    } catch (error) {
      if (diagnosticFromError(editorPath(uri), error) !== null) return null;
      throw error;
    }
    const offset = offsetAtPosition(document.source, position);
    const span = definitionAt(parsed.module, document.source, offset);
    if (span !== null) return { uri, range: rangeOf(document.source, span) };
    const field = fieldDefinitionAt(parsed.module, document.source, offset);
    if (field !== null) return { uri, range: rangeOf(document.source, field) };
    for (
      const imported of importReferencesAt(
        parsed.module,
        document.source,
        offset,
      )
    ) {
      const target = await this.#importedDefinition(
        uri,
        imported.specifier,
        imported.name,
      );
      if (target !== null) return target;
    }
    return null;
  }

  async typeDefinition(
    uri: string,
    position: Position,
  ): Promise<readonly Location[]> {
    const document = this.#requiredDocument(uri);
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(uri, document);
    } catch (error) {
      if (diagnosticFromError(editorPath(uri), error) !== null) return [];
      throw error;
    }
    const offset = offsetAtPosition(document.source, position);
    if (signatureTypeContaining(parsed.module, offset) !== null) {
      const selected = await this.definition(uri, position);
      if (selected === null) return [];
      return [selected];
    }
    const type = signatureTypeAt(parsed.module, document.source, offset);
    if (type === null) return [];
    const locations: Location[] = [];
    const seen = new Set<string>();
    for (const reference of typeReferenceSpans(type, document.source)) {
      const location = await this.definition(
        uri,
        positionAtOffset(document.source, reference.start),
      );
      if (location === null) continue;
      const key =
        `${location.uri}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push(location);
    }
    return locations;
  }

  async hover(uri: string, position: Position): Promise<Hover | null> {
    const document = this.#requiredDocument(uri);
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(uri, document);
    } catch (error) {
      if (diagnosticFromError(editorPath(uri), error) !== null) return null;
      throw error;
    }
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
    let markdown = description.markdown;
    if (checked !== null) {
      const explanation = explanationAt(checked, offset);
      if (explanation !== null) {
        markdown += `\n\n---\n\n**Why:** ${explanation.summary}`;
        for (const reason of explanation.reasons) markdown += `\n\n- ${reason}`;
      }
    }
    return {
      contents: { kind: "markdown", value: markdown },
      range: rangeOf(document.source, description.span),
    };
  }

  async completion(
    uri: string,
    position: Position,
  ): Promise<readonly CompletionItem[]> {
    const document = this.#requiredDocument(uri);
    const parsed = await this.#syntaxRevision(uri, document);
    const analysis = await this.#typedRevision(uri, document);
    const offset = offsetAtPosition(document.source, position);
    const items = new Map<string, CompletionItem>();
    for (const binding of moduleBindings(parsed.module)) {
      items.set(binding.name, { label: binding.name, kind: 6 });
    }
    if (analysis !== null) {
      const type = narrowestTypeAt(analysis, offset);
      if (type !== null) {
        for (const field of recordFields(type.type)) {
          items.set(field, { label: field, kind: 5, detail: type.type });
        }
        for (const constructor of variantConstructors(type.type)) {
          items.set(constructor, {
            label: constructor,
            kind: 20,
            detail: type.type,
          });
        }
      }
    }
    for (
      const keyword of [
        "break",
        "case",
        "const",
        "do",
        "else",
        "fn",
        "for",
        "if",
        "import",
        "in",
        "let",
        "module",
        "of",
        "open",
        "rec",
        "return",
        "with",
      ]
    ) {
      items.set(keyword, { label: keyword, kind: 13 });
    }
    return [...items.values()].sort((left, right) =>
      left.label.localeCompare(right.label)
    );
  }

  async signatureHelp(
    uri: string,
    position: Position,
  ): Promise<SignatureHelp | null> {
    const document = this.#requiredDocument(uri);
    const parsed = await this.#syntaxRevision(uri, document);
    const analysis = await this.#typedRevision(uri, document);
    if (analysis === null) return null;
    const offset = offsetAtPosition(document.source, position);
    const application = applicationAt(parsed.module, offset);
    if (application === null) return null;
    const functionType = typeForSpan(
      analysis,
      applicationCallee(application).span,
    );
    if (functionType === null || !functionType.includes("->")) return null;
    const parameters = arrowParameters(functionType).map((label) => ({
      label,
    }));
    return {
      signatures: [{ label: functionType, parameters }],
      activeSignature: 0,
      activeParameter: Math.min(
        applicationDepth(application) - 1,
        Math.max(0, parameters.length - 1),
      ),
    };
  }

  async inlayHints(
    uri: string,
    range?: Range,
  ): Promise<readonly InlayHint[]> {
    const document = this.#requiredDocument(uri);
    const parsed = await this.#syntaxRevision(uri, document);
    const analysis = await this.#typedRevision(uri, document);
    if (analysis === null) return [];
    let start = 0;
    let end = document.source.length;
    if (range !== undefined) {
      start = offsetAtPosition(document.source, range.start);
      end = offsetAtPosition(document.source, range.end);
    }
    const hints: InlayHint[] = [];
    for (const hole of signatureEditorFacts(parsed.module).holes) {
      if (hole.span.end < start || hole.span.start > end) continue;
      const type = typeForSpan(analysis, hole.span);
      if (type === null) continue;
      hints.push({
        position: positionAtOffset(document.source, hole.span.end),
        label: `: ${type}`,
        kind: 1,
        tooltip: "Compiler-inferred signature hole",
      });
    }
    return hints;
  }

  async documentSymbols(uri: string): Promise<readonly DocumentSymbol[]> {
    const document = this.#requiredDocument(uri);
    const parsed = await this.#syntaxRevision(uri, document);
    const analysis = await this.#typedRevision(uri, document);
    return moduleBindings(parsed.module).map((binding) => {
      let detail: string | undefined;
      if (analysis !== null) {
        const type = typeForSpan(analysis, binding.valueSpan);
        if (type !== null) detail = type;
      }
      let kind: 12 | 13 = 13;
      if (binding.function) kind = 12;
      return {
        name: binding.name,
        kind,
        range: rangeOf(document.source, binding.declarationSpan),
        selectionRange: rangeOf(document.source, binding.span),
        detail,
      };
    });
  }

  async references(
    uri: string,
    position: Position,
    includeDeclaration = true,
  ): Promise<readonly Location[]> {
    const document = this.#requiredDocument(uri);
    const parsed = await this.#syntaxRevision(uri, document);
    const offset = offsetAtPosition(document.source, position);
    const definition = definitionAt(parsed.module, document.source, offset);
    if (definition === null) return [];
    const locations: Location[] = [];
    for (const span of identifierSpans(document.source)) {
      const resolved = definitionAt(
        parsed.module,
        document.source,
        span.start,
      );
      if (!sameSpan(resolved, definition)) continue;
      if (!includeDeclaration && sameSpan(span, definition)) continue;
      locations.push({ uri, range: rangeOf(document.source, span) });
    }
    if (
      includeDeclaration &&
      !locations.some((location) =>
        sameRange(location.range, rangeOf(document.source, definition))
      )
    ) {
      locations.push({ uri, range: rangeOf(document.source, definition) });
    }
    return locations.sort((left, right) =>
      comparePosition(left.range.start, right.range.start)
    );
  }

  async rename(
    uri: string,
    position: Position,
    newName: string,
  ): Promise<WorkspaceEdit | null> {
    if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(newName)) {
      throw new Error(`\`${newName}\` is not a valid Blot binding name`);
    }
    const references = await this.references(uri, position, true);
    if (references.length === 0) return null;
    return {
      changes: {
        [uri]: references.map((location) => ({
          range: location.range,
          newText: newName,
        })),
      },
    };
  }

  async workspaceSymbols(query: string): Promise<readonly WorkspaceSymbol[]> {
    const symbols: WorkspaceSymbol[] = [];
    const folded = query.toLocaleLowerCase();
    for (const [uri, document] of this.#documents) {
      const parsed = await this.#syntaxRevision(uri, document);
      for (const binding of moduleBindings(parsed.module)) {
        if (!binding.name.toLocaleLowerCase().includes(folded)) continue;
        let kind: 12 | 13 = 13;
        if (binding.function) kind = 12;
        symbols.push({
          name: binding.name,
          kind,
          location: { uri, range: rangeOf(document.source, binding.span) },
        });
      }
    }
    return symbols.sort((left, right) => left.name.localeCompare(right.name));
  }

  async formatting(uri: string): Promise<readonly TextEdit[]> {
    const document = this.#requiredDocument(uri);
    let snapshot: CompilerSyntaxSnapshot;
    try {
      snapshot = await this.#syntaxRevision(uri, document);
    } catch (error) {
      if (diagnosticFromError(editorPath(uri), error) !== null) return [];
      throw error;
    }
    const formatted = await formatSource(document.source, {
      ok: true,
      module: snapshot.module,
      cst: snapshot.cst,
    });
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
    this.#syntaxSnapshots.clear();
  }

  #typedRevision(
    uri: string,
    document: OpenDocument,
  ): Promise<CompilerAnalysis | null> {
    const cached = this.#hoverChecks.get(uri);
    if (cached !== undefined && cached.version === document.version) {
      return cached.checked;
    }
    const path = editorPath(uri);
    const checked = this.#compiler.then((compiler) =>
      compiler.analyzeSource(path, document.source)
    ).catch((error) => {
      if (
        error instanceof BlotError || error instanceof LoadError ||
        (error instanceof Error && "code" in error && error.code === "ENOENT")
      ) return null;
      throw error;
    });
    this.#hoverChecks.set(uri, { version: document.version, checked });
    return checked;
  }

  async #validatedLints(
    uri: string,
    parsed: CompilerSyntaxSnapshot,
  ): Promise<readonly LintDiagnostic[]> {
    const document = this.#requiredDocument(uri);
    const analysis = await this.#typedRevision(uri, document);
    const diagnostics = lintModule(
      parsed.module,
      document.source,
      parsed.cst,
      DEFAULT_LINT_RULES,
      {
        specializations: analysis?.specializations,
        simplifications: analysis?.simplifications,
        readability: analysis?.readability,
      },
    );
    if (
      !diagnostics.some((diagnostic) =>
        diagnostic.fix !== null && diagnostic.fix.validation !== "parse"
      )
    ) return diagnostics;
    const path = editorPath(uri);
    const shadow = await Compiler.create();
    let original;
    try {
      original = await shadow.checkSource(path, document.source);
    } catch (error) {
      shadow.destroy();
      if (diagnosticFromError(path, error) === null) throw error;
      return diagnostics.filter((diagnostic) =>
        diagnostic.fix === null || diagnostic.fix.validation === "parse"
      );
    }
    const validated: LintDiagnostic[] = [];
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
          const checked = await shadow.checkSource(path, replacement);
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
      shadow.destroy();
    }
    return validated;
  }

  #syntaxRevision(
    uri: string,
    document: OpenDocument,
  ): Promise<CompilerSyntaxSnapshot> {
    const cached = this.#syntaxSnapshots.get(uri);
    if (cached !== undefined && cached.version === document.version) {
      return cached.snapshot;
    }
    const snapshot = this.#compiler.then((compiler) =>
      compiler.syntaxSnapshot(editorPath(uri), document.source)
    );
    this.#syntaxSnapshots.set(uri, {
      version: document.version,
      snapshot,
    });
    return snapshot;
  }

  #requiredDocument(uri: string): OpenDocument {
    const document = this.#documents.get(uri);
    if (document === undefined) throw new Error(`document ${uri} is not open`);
    return document;
  }

  #requireNextVersion(uri: string, current: number, next: number): void {
    if (next <= current) {
      throw new Error(
        `document ${uri} version ${next} does not follow ${current}`,
      );
    }
  }

  async #importedDefinition(
    importerUri: string,
    specifier: string,
    name: string,
  ): Promise<Location | null> {
    if (
      !specifier.startsWith(".") && !specifier.startsWith("/") &&
      !specifier.startsWith("blot:")
    ) {
      return null;
    }
    const targetPath = resolvePath(specifier, editorPath(importerUri));
    let targetUri = toFileUrl(targetPath).href;
    let targetSource: string | undefined;
    for (const [openUri, document] of this.#documents) {
      if (editorPath(openUri) !== targetPath) continue;
      targetUri = openUri;
      targetSource = document.source;
      break;
    }
    if (targetSource === undefined) {
      try {
        targetSource = await readFile(targetPath, "utf8");
      } catch (error) {
        if (
          error instanceof Error && "code" in error &&
          error.code === "ENOENT"
        ) {
          return null;
        }
        throw error;
      }
    }
    const snapshot = await (await this.#compiler).syntaxSnapshot(
      targetPath,
      targetSource,
    );
    const span = exportedDefinition(snapshot.module, targetSource, name);
    if (span === null) return null;
    return { uri: targetUri, range: rangeOf(targetSource, span) };
  }
}

interface BindingInfo {
  readonly name: string;
  readonly span: Span;
  readonly declarationSpan: Span;
  readonly valueSpan: Span;
  readonly function: boolean;
}

interface SignatureBindingInfo {
  readonly name: string;
  readonly declarationSpan: Span;
  readonly kind: "let" | "const";
  readonly recursive: boolean;
  readonly hasSignature: boolean;
}

interface SignatureCorrectionInfo {
  readonly name: string;
  readonly signatureSpan: Span;
  readonly valueSpan: Span;
  readonly kind: "let" | "const";
  readonly recursive: boolean;
}

interface SignatureEditorFacts {
  readonly holes: readonly Extract<Expr, { readonly tag: "var" }>[];
  readonly bindings: readonly SignatureBindingInfo[];
  readonly corrections: readonly SignatureCorrectionInfo[];
}

function signatureEditorFacts(module: Module): SignatureEditorFacts {
  const signatureHoles = new Map<
    number,
    Extract<Expr, { readonly tag: "var" }>
  >();
  const bindings: SignatureBindingInfo[] = [];
  const corrections: SignatureCorrectionInfo[] = [];

  function collectSignatureHoles(expression: Expr): void {
    if (expression.tag === "var" && expression.name === "_") {
      signatureHoles.set(expression.span.start, expression);
    }
    visitExpressionChildren(expression, collectSignatureHoles);
  }

  function inspectExpression(expression: Expr): void {
    if (expression.tag === "block") {
      inspectDeclarations(expression.declarations);
      inspectExpression(expression.result);
      return;
    }
    visitExpressionChildren(expression, inspectExpression);
  }

  function inspectDeclarations(declarations: readonly Decl[]): void {
    for (let index = 0; index < declarations.length; index += 1) {
      const declaration = declarations[index];
      if (declaration === undefined) continue;
      if (declaration.tag === "signature") {
        collectSignatureHoles(declaration.value);
        inspectExpression(declaration.value);
        const following = declarations[index + 1];
        if (
          following !== undefined &&
          following.tag === "binding" &&
          (following.kind === "let" || following.kind === "const") &&
          following.pattern.tag === "name"
        ) {
          const recursive = following.value.tag === "rec";
          if (
            declaration.kind !== following.kind ||
            declaration.recursive !== recursive ||
            declaration.name !== following.pattern.name
          ) {
            corrections.push({
              name: following.pattern.name,
              signatureSpan: declaration.span,
              valueSpan: declaration.value.span,
              kind: following.kind,
              recursive,
            });
          }
        }
        continue;
      }
      if (
        declaration.tag === "binding" &&
        (declaration.kind === "let" || declaration.kind === "const") &&
        declaration.pattern.tag === "name"
      ) {
        const previous = declarations[index - 1];
        const recursive = declaration.value.tag === "rec";
        const hasSignature = previous !== undefined &&
          previous.tag === "signature";
        bindings.push({
          name: declaration.pattern.name,
          declarationSpan: declaration.span,
          kind: declaration.kind,
          recursive,
          hasSignature,
        });
      }
      inspectExpression(declaration.value);
    }
  }

  inspectDeclarations(module.declarations);
  inspectExpression(module.result);
  return { holes: [...signatureHoles.values()], bindings, corrections };
}

function moduleBindings(module: Module): readonly BindingInfo[] {
  const bindings: BindingInfo[] = [];
  for (const declaration of module.declarations) {
    if (declaration.tag === "binding") {
      for (const binding of patternBindings(declaration.pattern)) {
        bindings.push({
          name: binding.name,
          span: binding.span,
          declarationSpan: declaration.span,
          valueSpan: declaration.value.span,
          function: isFunctionExpression(declaration.value),
        });
      }
      continue;
    }
    if (declaration.tag === "shadow") {
      bindings.push({
        name: declaration.name,
        span: declaration.span,
        declarationSpan: declaration.span,
        valueSpan: declaration.value.span,
        function: isFunctionExpression(declaration.value),
      });
    }
  }
  return bindings;
}

function patternBindings(
  pattern: Pattern,
): readonly { readonly name: string; readonly span: Span }[] {
  switch (pattern.tag) {
    case "name":
      return [{ name: pattern.name, span: pattern.span }];
    case "tuple":
    case "array":
      return pattern.elements.flatMap(patternBindings);
    case "constructor":
      if (pattern.payload === null) return [];
      return patternBindings(pattern.payload);
    case "shape":
      return pattern.fields.flatMap((field) => patternBindings(field.pattern));
    case "wildcard":
    case "pin":
    case "int":
    case "float":
    case "text":
    case "unit":
      return [];
  }
}

function isFunctionExpression(expression: Expr): boolean {
  if (expression.tag === "lambda") return true;
  return expression.tag === "rec" && expression.lambda.tag === "lambda";
}

function narrowestTypeAt(
  analysis: CompilerAnalysis,
  offset: number,
): CompilerAnalysis["types"][number] | null {
  const fact = analysis.types
    .filter((candidate) =>
      offset >= candidate.span.start && offset <= candidate.span.end
    )
    .sort((left, right) =>
      (left.span.end - left.span.start) - (right.span.end - right.span.start)
    )[0];
  if (fact === undefined) return null;
  return fact;
}

function typeForSpan(analysis: CompilerAnalysis, span: Span): string | null {
  const exact = analysis.types.find((fact) => sameSpan(fact.span, span));
  if (exact !== undefined) return exact.type;
  const containing = analysis.types
    .filter((fact) =>
      fact.span.start <= span.start && fact.span.end >= span.end
    )
    .sort((left, right) =>
      (left.span.end - left.span.start) - (right.span.end - right.span.start)
    )[0];
  if (containing === undefined) return null;
  return containing.type;
}

function recordFields(type: string): readonly string[] {
  return [...type.matchAll(/\.([\p{L}_][\p{L}\p{N}_]*)\s*=/gu)].map(
    (match) => match[1],
  ).filter((name): name is string => name !== undefined);
}

function variantConstructors(type: string): readonly string[] {
  return [...type.matchAll(/#([\p{L}_][\p{L}\p{N}_]*)/gu)].map(
    (match) => match[1],
  ).filter((name): name is string => name !== undefined);
}

function applicationAt(module: Module, offset: number):
  | Extract<Expr, {
    readonly tag: "apply";
  }>
  | null {
  const matches: Array<Extract<Expr, { readonly tag: "apply" }>> = [];
  const visit = (expression: Expr): void => {
    if (offset < expression.span.start || offset > expression.span.end) return;
    if (expression.tag === "apply") matches.push(expression);
    visitExpressionChildren(expression, visit);
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

function visitExpressionChildren(
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
    case "var":
    case "int":
    case "float":
    case "text":
    case "unit":
    case "intrinsic":
    case "tag":
      return;
  }
}

function typeReferenceSpans(type: Expr, source: string): readonly Span[] {
  const references: Span[] = [];
  const visit = (expression: Expr): void => {
    if (expression.tag === "var") {
      const span = identifierSpan(expression.span, expression.name, source);
      if (span !== null) references.push(span);
      return;
    }
    if (expression.tag === "field") {
      const span = fieldIdentifierSpan(expression, source);
      if (span !== null) references.push(span);
      return;
    }
    visitExpressionChildren(expression, visit);
  };
  visit(type);
  return references;
}

function arrowParameters(type: string): readonly string[] {
  const parts = type.split(" -> ");
  if (parts.length < 2) return [];
  return parts.slice(0, -1);
}

function applicationDepth(expression: Expr): number {
  if (expression.tag !== "apply") return 0;
  return 1 + applicationDepth(expression.fn);
}

function applicationCallee(expression: Expr): Expr {
  let callee = expression;
  while (callee.tag === "apply") callee = callee.fn;
  return callee;
}

interface ImportReference {
  readonly specifier: string;
  readonly name: string;
}

function importReferencesAt(
  module: Module,
  source: string,
  offset: number,
): readonly ImportReference[] {
  const expression = expressionAt(module, offset);
  if (expression === null) return [];
  if (expression.tag === "field") {
    const fieldSpan = fieldIdentifierSpan(expression, source);
    if (
      fieldSpan === null || offset < fieldSpan.start ||
      offset >= fieldSpan.end ||
      expression.target.tag !== "var"
    ) {
      return [];
    }
    const specifier = importedBindingSpecifier(
      module,
      expression.target.name,
    );
    if (specifier === null) return [];
    return [{ specifier, name: expression.name }];
  }
  if (expression.tag !== "var") return [];
  const references: ImportReference[] = [];
  for (const declaration of module.declarations.toReversed()) {
    if (declaration.tag !== "open") continue;
    const specifier = importSpecifier(declaration.value);
    if (specifier === null) continue;
    references.push({ specifier, name: expression.name });
  }
  return references;
}

function expressionAt(module: Module, offset: number): Expr | null {
  const matches: Expr[] = [];
  const visit = (expression: Expr): void => {
    if (offset < expression.span.start || offset >= expression.span.end) return;
    matches.push(expression);
    visitExpressionChildren(expression, visit);
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

function fieldIdentifierSpan(
  expression: Extract<Expr, { readonly tag: "field" }>,
  source: string,
): Span | null {
  const tail = source.slice(expression.target.span.end, expression.span.end);
  const relative = tail.lastIndexOf(expression.name);
  if (relative < 0) return null;
  const start = expression.target.span.end + relative;
  return { start, end: start + expression.name.length };
}

function importedBindingSpecifier(module: Module, name: string): string | null {
  for (const declaration of module.declarations.toReversed()) {
    if (
      declaration.tag !== "binding" ||
      declaration.pattern.tag !== "name" || declaration.pattern.name !== name
    ) {
      continue;
    }
    return importSpecifier(declaration.value);
  }
  return null;
}

function importSpecifier(expression: Expr): string | null {
  if (expression.tag !== "apply") return null;
  if (
    expression.fn.tag === "intrinsic" &&
    expression.fn.name === "@import" && expression.arg.tag === "text"
  ) {
    return expression.arg.value;
  }
  return importSpecifier(expression.fn);
}

function exportedDefinition(
  module: Module,
  source: string,
  name: string,
): Span | null {
  if (module.result.tag !== "shape") {
    if (name !== "default") return null;
    const definition = definitionAt(module, source, module.result.span.start);
    if (definition !== null) return definition;
    return module.result.span;
  }
  for (const member of module.result.members) {
    if (member.tag !== "field" || member.name !== name) continue;
    const definition = definitionAt(module, source, member.value.span.start);
    if (definition !== null) return definition;
    return member.value.span;
  }
  return null;
}

function identifierSpans(source: string): readonly Span[] {
  return [...source.matchAll(/[\p{L}_][\p{L}\p{N}_]*/gu)].map((match) => {
    const start = match.index;
    return { start, end: start + match[0].length };
  });
}

function sameSpan(left: Span | null, right: Span): boolean {
  return left !== null && left.start === right.start && left.end === right.end;
}

function sameRange(left: Range, right: Range): boolean {
  return comparePosition(left.start, right.start) === 0 &&
    comparePosition(left.end, right.end) === 0;
}

function comparePosition(left: Position, right: Position): number {
  if (left.line !== right.line) return left.line - right.line;
  return left.character - right.character;
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

function editorPath(uri: string): string {
  const path = filePath(uri);
  if (path !== null) return path;
  const safe = encodeURIComponent(uri).replaceAll("%", "_");
  return resolve(`.blot-editor-${safe}.blot`);
}
