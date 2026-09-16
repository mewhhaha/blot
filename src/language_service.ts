import { readFile } from "node:fs/promises";
import { fromFileUrl, resolve, toFileUrl } from "@std/path";
import {
  type CheckedModule,
  Compiler,
  type CompilerAnalysis,
  type CompilerSyntaxSnapshot,
  explanationAt,
} from "./compiler.ts";
import { BlotError } from "./diagnostic.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { importExpressions, LoadError, resolvePath } from "./load.ts";
import {
  isPackageSpecifier,
  PackageArtifactError,
  resolvePackageExport,
} from "./package_format.ts";
import type { Decl, Expr, Module, Pattern, Span } from "./syntax/ast.ts";
import { parse } from "./syntax/parse.ts";
import { snapshotSource } from "./syntax/snapshot.ts";
import {
  definitionAt,
  fieldDefinitionAt,
  identifierSpan,
  signatureTypeAt,
  signatureTypeContaining,
} from "./tooling/definition.ts";
import { assertEditReconstructs, deriveEdit } from "./tooling/format/edits.ts";
import { formatSource } from "./tooling/formatter.ts";
import { hoverAt } from "./tooling/hover.ts";
import {
  type ContentChange,
  offsetAtPosition,
  type Position,
  positionAtOffset,
  type Range,
  rangeOf,
} from "./text/document.ts";
import {
  type AnalysisResult,
  captureOverlayManifest,
  DependencyCache,
  diffOverlayManifest,
  failedAnalysis,
  type OverlayManifest,
  overlayManifestDigest,
  successfulAnalysis,
} from "./lsp/analysis.ts";
import {
  analysisCacheKey,
  SYNTAX_FRONTEND_ID,
  syntaxCacheKey,
} from "./text/cache.ts";
import { type DocumentSnapshot, DocumentStore } from "./text/store.ts";
import { DEFAULT_LINT_RULES, lintModule } from "./tooling/lint.ts";
import type {
  LintCandidateIdentity,
  LintDiagnostic,
  SplitLintDiagnostics,
} from "./tooling/lint.ts";
import {
  findLintCandidate,
  lintCandidateIdentity,
  splitLintDiagnostics,
} from "./tooling/lint.ts";
import { ScratchValidationSession } from "./tooling/lint.ts";
import { sourceCodeSpan } from "./tooling/lint/syntax.ts";
import { fixLintSource } from "./tooling/lint_command.ts";
import type { StagedOverlay } from "./workspace_graph.ts";

export type { ContentChange, Position, Range } from "./text/document.ts";
export type { DocumentSnapshot } from "./text/store.ts";
export { offsetAtPosition, positionAtOffset, rangeOf };

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

/**
 * The deferred-action binding carried by every resolvable code action.
 *
 * The action describes a candidate observed at one request: `uri` names the
 * document, `version`/`lifecycle`/`revision` pin the exact open revision the
 * candidate was described against, and `workspaceEpoch` names the workspace
 * the description assumed. `rule` scopes fix-all actions and names the
 * single-fix rule; `candidate` identifies one selected fix within its
 * revision (absent for fix-all). Resolve re-detects on the current revision
 * and validates only the selected candidate, returning edits only when that
 * validation succeeds. A revision move (close, lifecycle, revision, or
 * version mismatch) is stale and never returns edits; a workspace move with
 * an unchanged revision re-proves against the current workspace.
 */
export interface CodeActionData {
  readonly uri: string;
  readonly version: number;
  readonly lifecycle: number;
  readonly revision: number;
  readonly workspaceEpoch: number;
  readonly rule?: string;
  readonly candidate?: LintCandidateIdentity;
}

export interface CodeAction {
  readonly title: string;
  readonly kind:
    | "quickfix"
    | "refactor.rewrite"
    | `source.fixAll.blot${string}`;
  readonly diagnostics: readonly LanguageDiagnostic[];
  readonly data?: CodeActionData;
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

/**
 * The compiler surface the language service drives. `Compiler` satisfies
 * this; tests inject fakes to count analyses and control ordering without
 * the Wasm artifact.
 */
export interface SemanticCompiler {
  analyzeSource(path: string, source: string): Promise<CompilerAnalysis>;
  syntaxSnapshot(path: string, source: string): Promise<CompilerSyntaxSnapshot>;
  stageOverlays(entries: ReadonlyMap<string, StagedOverlay>): Promise<void>;
  workspaceClosure(path: string): Promise<readonly string[]>;
  refreshDiskInputs(): Promise<void>;
  releaseRoot(path: string): Promise<void>;
  clearOverlay(path: string): Promise<void>;
  destroy(): void;
}

/**
 * The compiler surface behind lint-fix validation. Validation runs fixed
 * source variants that must never clobber the service workspace, so it
 * stays on a separate compiler behind the scratch validation session, which
 * seeds it with the requesting revision's overlay snapshot before checking
 * anything; `Compiler` satisfies this too.
 */
export interface ValidationCompiler {
  analyzeSource(path: string, source: string): Promise<CompilerAnalysis>;
  syntaxSnapshot(path: string, source: string): Promise<CompilerSyntaxSnapshot>;
  checkSource(path: string, source: string): Promise<CheckedModule>;
  stageOverlays(entries: ReadonlyMap<string, StagedOverlay>): Promise<void>;
  clearOverlay(path: string): Promise<void>;
  destroy(): void;
}

export interface LanguageServiceOptions {
  readonly createCompiler?: () => Promise<SemanticCompiler>;
  readonly createValidationCompiler?: () => Promise<ValidationCompiler>;
}

interface DocumentCaches {
  readonly lifecycle: number;
  readonly syntax: DependencyCache<CompilerSyntaxSnapshot>;
  readonly semantic: DependencyCache<AnalysisResult>;
}

interface EpochChange {
  readonly epoch: number;
  readonly paths: ReadonlySet<string>;
}

const maximumInlayHintLength = 60;
const inlayHintSegments = new Intl.Segmenter("en", { granularity: "grapheme" });
// Syntax and analysis results cached per open document. The key is content
// identity (plus the frontend identity for syntax), so repeated or restored
// content hits across revisions while every distinct edit fills one slot.
// Entries also carry their workspace epoch and dependency closure, so an
// overlay, disk, or configuration change invalidates exactly the entries
// whose observed inputs moved.
const maximumCachedContents = 16;
// The epoch log bounds how far back lazy invalidation can reach. Entries
// older than the retained window recompute instead of serving.
const maximumEpochLog = 512;
// Clients without resolve support receive eagerly validated edits, but one
// code-action request validates at most this many relevant candidates:
// detection still describes every candidate while validation stays bounded.
// Resolve-capable clients defer every candidate instead and validate only
// the selected action, so this bound never drops their actions.
export const MAX_EAGER_ACTION_VALIDATIONS = 32;

export class LanguageService {
  readonly #store = new DocumentStore();
  readonly #caches = new Map<string, DocumentCaches>();
  readonly #compiler: Promise<SemanticCompiler>;
  readonly #createValidationCompiler: () => Promise<ValidationCompiler>;
  #scratch: ScratchValidationSession | undefined = undefined;
  #workspaceEpoch = 1;
  readonly #epochChanges: EpochChange[] = [];
  #syncedManifest: OverlayManifest | null = null;
  #diskRefreshPending = false;

  constructor(options: LanguageServiceOptions = {}) {
    if (options.createCompiler !== undefined) {
      this.#compiler = options.createCompiler();
    } else {
      this.#compiler = Compiler.create();
    }
    if (options.createValidationCompiler !== undefined) {
      this.#createValidationCompiler = options.createValidationCompiler;
    } else {
      this.#createValidationCompiler = () => Compiler.create();
    }
  }

  open(uri: string, source: string, version: number): void {
    const snapshot = this.#store.open(uri, source, version);
    this.#caches.set(uri, this.#freshCaches(snapshot.lifecycle));
    this.#noteWorkspaceChange(editorPath(uri));
  }

  change(uri: string, source: string, version: number): void {
    this.#store.change(uri, source, version);
    this.#noteWorkspaceChange(editorPath(uri));
  }

  changeRanges(
    uri: string,
    changes: readonly ContentChange[],
    version: number,
  ): void {
    this.#store.changeRanges(uri, changes, version);
    this.#noteWorkspaceChange(editorPath(uri));
  }

  async close(uri: string): Promise<void> {
    const path = editorPath(uri);
    this.#store.close(uri);
    this.#caches.delete(uri);
    this.#noteWorkspaceChange(path);
    const compiler = await this.#compiler;
    await compiler.releaseRoot(path);
    await compiler.clearOverlay(path);
  }

  /**
   * Records an out-of-band disk or configuration change (watcher events,
   * package or include edits outside the editor) so dependent semantic
   * entries invalidate. The next computation refreshes the compiler's disk
   * inputs before analyzing; recording itself loads nothing.
   */
  markChanged(path: string): void {
    this.#noteWorkspaceChange(resolve(path));
    this.#diskRefreshPending = true;
  }

  /** Reads cache shape for tests: per-open-document entry counts. */
  debugCacheStats(): {
    readonly documents: number;
    readonly entries: ReadonlyArray<{
      readonly uri: string;
      readonly syntax: number;
      readonly semantic: number;
    }>;
  } {
    const entries: Array<
      {
        readonly uri: string;
        readonly syntax: number;
        readonly semantic: number;
      }
    > = [];
    for (const [uri, caches] of this.#caches) {
      entries.push({
        uri,
        syntax: caches.syntax.size,
        semantic: caches.semantic.size,
      });
    }
    return { documents: this.#caches.size, entries };
  }

  version(uri: string): number | null {
    return this.#store.version(uri);
  }

  snapshot(uri: string): DocumentSnapshot | null {
    return this.#store.snapshot(uri);
  }

  async diagnostics(uri: string): Promise<readonly LanguageDiagnostic[]> {
    const snapshot = this.#requiredSnapshot(uri);
    const source = snapshot.document.source;
    const path = editorPath(uri);
    const overlays = this.#requestOverlays();
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(snapshot);
    } catch (error) {
      const rejected = diagnosticsFromError(path, error);
      if (rejected !== null) {
        return rejected.map((diagnostic) =>
          languageDiagnostic(source, diagnostic, 1)
        );
      }
      throw error;
    }

    const diagnostics: LanguageDiagnostic[] = [];
    const result = await this.#analysisRevision(snapshot);
    const failure = result.failure;
    if (failure !== null) {
      for (const diagnostic of failure.diagnostics) {
        diagnostics.push(languageDiagnostic(source, diagnostic, 1));
      }
    } else {
      const analysis = result.analysis;
      if (analysis === null) {
        throw new Error(
          `analysis of ${uri} returned neither facts nor a source failure`,
        );
      }
      if (!analysis.targetPreflight.supported) {
        let message = analysis.targetPreflight.unsupportedComponent;
        if (message === null) {
          message =
            "The inferred export is not supported by the selected Wasm target.";
        }
        diagnostics.push(languageDiagnostic(source, {
          code: "BLOT_TARGET_REFUSAL",
          message,
          span: { start: 0, end: 0 },
        }, 1));
      }
    }
    // Detection publishes without speculative compilation: claims
    // established by current syntax or semantic facts need no fix check.
    // Rewrite-validation claims keep their validation in the lower-priority
    // stage below and never publish unproven.
    const detected = await this.#lintSplit(snapshot, parsed);
    const proven = new Set<LintDiagnostic>();
    if (detected.split.rewriteCandidates.length > 0) {
      const session = this.#scratchSession();
      for (const candidate of detected.split.rewriteCandidates) {
        const fix = candidate.fix;
        if (fix === null) continue;
        if (
          await session.validateFix({ path, source, overlays, fix })
        ) {
          proven.add(candidate);
        }
      }
    }
    const held = new Set(detected.split.rewriteCandidates);
    for (const diagnostic of detected.detected) {
      if (held.has(diagnostic) && !proven.has(diagnostic)) continue;
      diagnostics.push(languageDiagnostic(
        source,
        diagnostic,
        lintLanguageSeverity(diagnostic.severity),
      ));
    }
    return diagnostics;
  }

  async codeActions(
    uri: string,
    range: Range,
    context: {
      readonly only?: readonly string[];
      readonly resolveEdits?: boolean;
    } = {},
  ): Promise<readonly CodeAction[]> {
    const snapshot = this.#requiredSnapshot(uri);
    const document = snapshot.document;
    const workspaceEpoch = this.#workspaceEpoch;
    const overlays = this.#requestOverlays();
    const accepts = (kind: string) =>
      context.only === undefined ||
      context.only.some((requested) =>
        kind === requested || kind.startsWith(requested + ".")
      );
    const requestedStart = offsetAtPosition(document.source, range.start);
    const requestedEnd = offsetAtPosition(document.source, range.end);
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(snapshot);
    } catch (error) {
      const rejected = diagnosticsFromError(editorPath(uri), error);
      if (rejected !== null) {
        const actions: CodeAction[] = [];
        for (const diagnostic of rejected) {
          if (diagnostic.code !== "BLOT_UNREACHABLE_STATEMENT") continue;
          if (
            requestedEnd < diagnostic.span.start ||
            requestedStart > diagnostic.span.end
          ) continue;
          const editSpan = unreachableStatementRemovalSpan(
            document.source,
            diagnostic.span,
          );
          const replacement = document.source.slice(0, editSpan.start) +
            document.source.slice(editSpan.end);
          if (!(await parse(replacement)).ok) continue;
          actions.push({
            title: "Remove unreachable statement",
            kind: "quickfix",
            diagnostics: [languageDiagnostic(document.source, diagnostic, 1)],
            edit: {
              documentChanges: [{
                textDocument: { uri, version: snapshot.version },
                edits: [{
                  range: rangeOf(document.source, editSpan),
                  newText: "",
                }],
              }],
            },
          });
        }
        return deduplicateCodeActions(
          actions.filter((action) => accepts(action.kind)),
        );
      }
      // A deleted or unloadable dependency leaves no diagnostics to act on;
      // operational failures stay loud.
      if (!isSourceFailure(error)) throw error;
      return [];
    }
    const actions: CodeAction[] = [];
    const detected = await this.#lintSplit(snapshot, parsed);
    const deferred = context.resolveEdits === true;
    if (
      deferred ||
      context.only?.some((kind) =>
        kind === "source" || kind.startsWith("source.fixAll")
      )
    ) {
      actions.push(
        ...await this.#fixAllActions(
          snapshot,
          workspaceEpoch,
          range,
          accepts,
          detected.detected,
          deferred,
        ),
      );
    }
    // Detection describes every candidate with zero fix validations. Clients
    // with resolve support receive deferred descriptions bound to this
    // revision; clients without it receive eagerly validated edits for the
    // requested relevant candidates only, under a bounded request.
    const relevant = detected.detected.filter((diagnostic) =>
      diagnostic.fix !== null &&
      requestedEnd >= diagnostic.span.start &&
      requestedStart <= diagnostic.span.end &&
      accepts(diagnostic.fix.kind)
    );
    if (deferred) {
      const publishable = new Set(detected.split.publishable);
      for (const diagnostic of relevant) {
        const fix = diagnostic.fix;
        if (fix === null) continue;
        const identity = lintCandidateIdentity(diagnostic);
        if (identity === null) continue;
        let actionDiagnostics: readonly LanguageDiagnostic[] = [];
        if (publishable.has(diagnostic)) {
          actionDiagnostics = [languageDiagnostic(
            document.source,
            diagnostic,
            lintLanguageSeverity(diagnostic.severity),
          )];
        }
        actions.push({
          title: fix.title,
          kind: fix.kind,
          diagnostics: actionDiagnostics,
          data: {
            uri,
            version: snapshot.version,
            lifecycle: snapshot.lifecycle,
            revision: snapshot.revision,
            workspaceEpoch,
            rule: diagnostic.code,
            candidate: identity,
          },
          edit: {
            documentChanges: [{
              textDocument: { uri, version: snapshot.version },
              edits: [],
            }],
          },
        });
      }
    } else {
      const budgeted = new Set(
        relevant.toSorted(compareActionCandidates).slice(
          0,
          MAX_EAGER_ACTION_VALIDATIONS,
        ),
      );
      const session = this.#scratchSession();
      const path = editorPath(uri);
      for (const diagnostic of relevant) {
        if (!budgeted.has(diagnostic)) continue;
        const fix = diagnostic.fix;
        if (fix === null) continue;
        if (
          !await session.validateFix({
            path,
            source: document.source,
            overlays,
            fix,
          })
        ) continue;
        actions.push({
          title: fix.title,
          kind: fix.kind,
          diagnostics: [languageDiagnostic(
            document.source,
            diagnostic,
            lintLanguageSeverity(diagnostic.severity),
          )],
          edit: {
            documentChanges: [{
              textDocument: { uri, version: snapshot.version },
              edits: fix.edits.map((edit) => ({
                range: rangeOf(document.source, edit.span),
                newText: edit.replacement,
              })),
            }],
          },
        });
      }
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
            textDocument: { uri, version: snapshot.version },
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
            textDocument: { uri, version: snapshot.version },
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
    return deduplicateCodeActions(
      actions.filter((action) => accepts(action.kind)),
    );
  }

  async #fixAllActions(
    snapshot: DocumentSnapshot,
    workspaceEpoch: number,
    range: Range,
    accepts: (kind: string) => boolean,
    diagnostics: readonly LintDiagnostic[],
    resolveEdits: boolean,
  ): Promise<readonly CodeAction[]> {
    const uri = snapshot.uri;
    const document = snapshot.document;
    if (
      !diagnostics.some((diagnostic) => diagnostic.fix?.kind === "quickfix")
    ) return [];
    const start = offsetAtPosition(document.source, range.start);
    const end = offsetAtPosition(document.source, range.end);
    const rules = new Set(
      diagnostics.filter((diagnostic) =>
        diagnostic.fix?.kind === "quickfix" && diagnostic.span.start <= end &&
        diagnostic.span.end >= start
      ).map((diagnostic) => diagnostic.code),
    );
    const selections: {
      kind: CodeAction["kind"];
      title: string;
      rule?: string;
    }[] = [{
      kind: "source.fixAll.blot",
      title: "Fix all safe Blot suggestions",
    }];
    for (const rule of [...rules].sort()) {
      selections.push({
        kind: `source.fixAll.blot.${rule}`,
        title: `Fix all ${
          rule.replace("BLOT_LINT_", "").toLowerCase().replaceAll("_", " ")
        } suggestions`,
        rule,
      });
    }
    const actions: CodeAction[] = [];
    for (const selection of selections) {
      if (!accepts(selection.kind)) continue;
      const action: CodeAction = {
        title: selection.title,
        kind: selection.kind,
        diagnostics: [],
        data: {
          uri,
          version: snapshot.version,
          lifecycle: snapshot.lifecycle,
          revision: snapshot.revision,
          workspaceEpoch,
          rule: selection.rule,
        },
        edit: {
          documentChanges: [{
            textDocument: { uri, version: snapshot.version },
            edits: [],
          }],
        },
      };
      if (resolveEdits) actions.push(action);
      else actions.push(await this.resolveCodeAction(action));
    }
    return actions;
  }

  async resolveCodeAction(action: CodeAction): Promise<CodeAction> {
    const selection = action.data;
    if (selection === undefined) return action;
    const candidate = selection.candidate;
    if (candidate === undefined) {
      return await this.#resolveFixAllAction(action, selection);
    }
    if (
      typeof selection.uri !== "string" ||
      !Number.isSafeInteger(selection.version) ||
      !Number.isSafeInteger(selection.lifecycle) ||
      !Number.isSafeInteger(selection.revision) ||
      !Number.isSafeInteger(selection.workspaceEpoch) ||
      typeof selection.rule !== "string" ||
      !DEFAULT_LINT_RULES.some((rule) => rule.code === selection.rule) ||
      typeof candidate.start !== "number" ||
      !Number.isSafeInteger(candidate.start) ||
      candidate.start < 0 ||
      typeof candidate.end !== "number" ||
      !Number.isSafeInteger(candidate.end) ||
      candidate.end < candidate.start ||
      typeof candidate.title !== "string" ||
      candidate.title.length === 0
    ) {
      throw new Error("Invalid Blot code action");
    }
    const snapshot = this.#store.snapshot(selection.uri);
    const overlays = this.#requestOverlays();
    if (
      snapshot === null ||
      snapshot.lifecycle !== selection.lifecycle ||
      snapshot.revision !== selection.revision ||
      snapshot.version !== selection.version
    ) {
      return emptyResolvedAction(action, selection.uri, selection.version);
    }
    const document = snapshot.document;
    // Re-detection performs zero validations; only the selected candidate is
    // validated, in the scratch session, and edits return only when that
    // validation succeeds. A workspace move under an unchanged revision
    // re-proves against the current workspace instead of going stale.
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(snapshot);
    } catch (error) {
      if (diagnosticsFromError(editorPath(selection.uri), error) === null) {
        throw error;
      }
      return emptyResolvedAction(action, selection.uri, selection.version);
    }
    const detected = await this.#lintSplit(snapshot, parsed);
    const match = findLintCandidate(
      detected.detected,
      selection.rule,
      candidate,
    );
    if (match === null || match.fix === null) {
      return emptyResolvedAction(action, selection.uri, selection.version);
    }
    const proven = await this.#scratchSession().validateFix({
      path: editorPath(selection.uri),
      source: document.source,
      overlays,
      fix: match.fix,
    });
    if (!proven) {
      return emptyResolvedAction(action, selection.uri, selection.version);
    }
    return {
      title: action.title,
      kind: action.kind,
      diagnostics: [languageDiagnostic(
        document.source,
        match,
        lintLanguageSeverity(match.severity),
      )],
      edit: {
        documentChanges: [{
          textDocument: { uri: selection.uri, version: snapshot.version },
          edits: match.fix.edits.map((edit) => ({
            range: rangeOf(document.source, edit.span),
            newText: edit.replacement,
          })),
        }],
      },
    };
  }

  async #resolveFixAllAction(
    action: CodeAction,
    selection: CodeActionData,
  ): Promise<CodeAction> {
    if (
      typeof selection.uri !== "string" ||
      !Number.isSafeInteger(selection.version) ||
      !Number.isSafeInteger(selection.lifecycle) ||
      !Number.isSafeInteger(selection.revision) ||
      !Number.isSafeInteger(selection.workspaceEpoch) ||
      (selection.rule !== undefined &&
        !DEFAULT_LINT_RULES.some((rule) => rule.code === selection.rule))
    ) {
      throw new Error("Invalid Blot fix-all action");
    }
    const snapshot = this.#requiredSnapshot(selection.uri);
    const overlays = this.#requestOverlays();
    const document = snapshot.document;
    if (
      snapshot.lifecycle !== selection.lifecycle ||
      snapshot.revision !== selection.revision ||
      snapshot.version !== selection.version
    ) {
      throw new Error("The document changed; request code actions again");
    }
    const path = editorPath(selection.uri);
    const source = document.source;
    const fixed = await this.#scratchSession().runExclusive(
      { path, source, overlays },
      (compiler) =>
        fixLintSource(
          { analysis: compiler, validation: compiler },
          path,
          source,
          { rule: selection.rule },
        ),
    );
    return {
      title: action.title,
      kind: action.kind,
      diagnostics: action.diagnostics,
      edit: {
        documentChanges: [{
          textDocument: { uri: selection.uri, version: snapshot.version },
          edits: [{
            range: rangeOf(document.source, {
              start: 0,
              end: document.source.length,
            }),
            newText: fixed.source,
          }],
        }],
      },
    };
  }

  async definition(
    uri: string,
    position: Position,
  ): Promise<Location | null> {
    const snapshot = this.#requiredSnapshot(uri);
    const workspace = this.#store.snapshots();
    return await this.#definitionAt(snapshot, workspace, position);
  }

  async #definitionAt(
    snapshot: DocumentSnapshot,
    workspace: readonly DocumentSnapshot[],
    position: Position,
  ): Promise<Location | null> {
    const uri = snapshot.uri;
    const document = snapshot.document;
    let module: Module;
    let sourceGraphLoaded = false;
    try {
      module = (await this.#syntaxRevision(snapshot)).module;
      sourceGraphLoaded = true;
    } catch (error) {
      if (!isSourceFailure(error)) throw error;
      // A broken dependency must not prevent syntax-only source navigation.
      const parsed = await parse(document.source);
      if (!parsed.ok) return null;
      module = parsed.module;
    }
    const offset = offsetAtPosition(document.source, position);
    for (const [expression, specifier] of importExpressions(module)) {
      if (offset >= expression.span.start && offset < expression.span.end) {
        return await this.#importedDefinition(uri, workspace, specifier);
      }
    }
    const span = definitionAt(module, document.source, offset);
    if (span !== null) return { uri, range: rangeOf(document.source, span) };
    const field = fieldDefinitionAt(module, document.source, offset);
    if (field !== null) return { uri, range: rangeOf(document.source, field) };
    if (!sourceGraphLoaded) return null;
    for (
      const imported of importReferencesAt(
        module,
        document.source,
        offset,
      )
    ) {
      const target = await this.#importedDefinition(
        uri,
        workspace,
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
    const snapshot = this.#requiredSnapshot(uri);
    const workspace = this.#store.snapshots();
    const document = snapshot.document;
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(snapshot);
    } catch (error) {
      if (diagnosticsFromError(editorPath(uri), error) !== null) return [];
      throw error;
    }
    const offset = offsetAtPosition(document.source, position);
    if (signatureTypeContaining(parsed.module, offset) !== null) {
      const selected = await this.#definitionAt(snapshot, workspace, position);
      if (selected === null) return [];
      return [selected];
    }
    const type = signatureTypeAt(parsed.module, document.source, offset);
    if (type === null) return [];
    const locations: Location[] = [];
    const seen = new Set<string>();
    for (const reference of typeReferenceSpans(type, document.source)) {
      const location = await this.#definitionAt(
        snapshot,
        workspace,
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
    const snapshot = this.#requiredSnapshot(uri);
    const document = snapshot.document;
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(snapshot);
    } catch (error) {
      // A broken input leaves no facts to describe; operational failures
      // stay loud. Missing inputs surface through diagnostics.
      if (!isSourceFailure(error)) throw error;
      return null;
    }
    const checked = await this.#typedRevision(snapshot);
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
    const snapshot = this.#requiredSnapshot(uri);
    const document = snapshot.document;
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(snapshot);
    } catch (error) {
      // A broken input leaves no bindings to complete, mirroring the
      // analysis-stage degrade below; operational failures stay loud.
      if (!isSourceFailure(error)) throw error;
      return [];
    }
    const analysis = await this.#typedRevision(snapshot);
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
    const snapshot = this.#requiredSnapshot(uri);
    const document = snapshot.document;
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(snapshot);
    } catch (error) {
      // A broken input leaves no application to describe, mirroring the
      // analysis-stage degrade below; operational failures stay loud.
      if (!isSourceFailure(error)) throw error;
      return null;
    }
    const analysis = await this.#typedRevision(snapshot);
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
    const snapshot = this.#requiredSnapshot(uri);
    const document = snapshot.document;
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(snapshot);
    } catch (error) {
      // A deleted or unloadable dependency leaves no facts to hint at; the
      // missing input surfaces through diagnostics, not an empty provider.
      if (!isSourceFailure(error)) throw error;
      return [];
    }
    const analysis = await this.#typedRevision(snapshot);
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
      const fullLabel = `: ${type}`;
      const label = truncateInlayHint(fullLabel);
      let tooltip = "Compiler-inferred signature hole";
      if (label !== fullLabel) tooltip += `\n\n${type}`;
      hints.push({
        position: positionAtOffset(document.source, hole.span.end),
        label,
        kind: 1,
        tooltip,
      });
    }
    return hints;
  }

  async documentSymbols(uri: string): Promise<readonly DocumentSymbol[]> {
    const snapshot = this.#requiredSnapshot(uri);
    const document = snapshot.document;
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(snapshot);
    } catch (error) {
      // A broken input leaves no bindings to outline, mirroring the
      // analysis-stage degrade below; operational failures stay loud.
      if (!isSourceFailure(error)) throw error;
      return [];
    }
    const analysis = await this.#typedRevision(snapshot);
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
    return await this.#referencesAt(
      this.#requiredSnapshot(uri),
      position,
      includeDeclaration,
    );
  }

  async #referencesAt(
    snapshot: DocumentSnapshot,
    position: Position,
    includeDeclaration: boolean,
  ): Promise<readonly Location[]> {
    const uri = snapshot.uri;
    const document = snapshot.document;
    let parsed: CompilerSyntaxSnapshot;
    try {
      parsed = await this.#syntaxRevision(snapshot);
    } catch (error) {
      // A broken input leaves no bindings to resolve, so references and
      // rename (which refuses empty matches) degrade; operational failures
      // stay loud.
      if (!isSourceFailure(error)) throw error;
      return [];
    }
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
    const snapshot = this.#requiredSnapshot(uri);
    const references = await this.#referencesAt(snapshot, position, true);
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
    // One frozen workspace capture at entry: every document below is the
    // revision the request started with, never a mid-request re-read.
    const workspace = this.#store.snapshots();
    for (const snapshot of workspace) {
      const uri = snapshot.uri;
      const document = snapshot.document;
      const parsed = await this.#syntaxRevision(snapshot);
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

  async formatting(
    uri: string,
    options?: unknown,
  ): Promise<readonly TextEdit[]> {
    const documentSnapshot = this.#requiredSnapshot(uri);
    const document = documentSnapshot.document;
    // Formatting is syntax-only: the source snapshot never touches the
    // workspace graph, resolves no imports, and instantiates no semantic
    // compiler. Invalid source yields no edits; an operational failure inside
    // the snapshot (missing Wasm, an invariant break) propagates so the
    // coordinator settles an explicit backend failure instead of silently
    // dropping the format. Options are validated (misconfigured clients fail
    // loudly) but the house style never varies; the returned edit is the
    // minimal prefix/suffix replacement, verified to reconstruct the
    // validated output exactly.
    const snapshot = await snapshotSource(document.source);
    if (!snapshot.ok) return [];
    const formatted = await formatSource(
      document.source,
      snapshot.snapshot,
      undefined,
      { options },
    );
    if (!formatted.ok || formatted.source === document.source) return [];
    const edit = deriveEdit(document.source, formatted.source);
    if (edit === null) return [];
    assertEditReconstructs(document.source, formatted.source, edit);
    return [{ range: edit.range, newText: edit.newText }];
  }

  async destroy(): Promise<void> {
    (await this.#compiler).destroy();
    const scratch = this.#scratch;
    this.#scratch = undefined;
    if (scratch !== undefined) await scratch.destroy();
    this.#store.clear();
    this.#caches.clear();
  }

  /**
   * The one shared semantic computation per revision. The first subscriber
   * synchronizes every open overlay, runs the analysis, and records the
   * observed dependency closure; concurrent same-key subscribers share the
   * in-flight promise. Structured source failures cache as results;
   * infrastructure failures are shared in-flight but never served again.
   */
  #analysisRevision(snapshot: DocumentSnapshot): Promise<AnalysisResult> {
    const source = snapshot.document.source;
    const caches = this.#cachesFor(snapshot);
    const key = analysisCacheKey(source);
    const cached = caches.semantic.get(
      key,
      source,
      (epoch) => this.#changesSince(epoch),
    );
    if (cached !== undefined) return cached;
    const uri = snapshot.uri;
    const path = editorPath(uri);
    const revision = snapshot.revision;
    const lifecycle = snapshot.lifecycle;
    const startEpoch = this.#workspaceEpoch;
    const manifest = this.#captureManifest();
    const manifestDigest = overlayManifestDigest(manifest);
    const computed = (async (): Promise<AnalysisResult> => {
      const syncMs = await this.#syncOverlays(manifest);
      await this.#refreshDiskInputsIfNeeded();
      const compiler = await this.#compiler;
      const start = Date.now();
      try {
        const analysis = await compiler.analyzeSource(path, source);
        const result = successfulAnalysis(
          {
            uri,
            lifecycle,
            revision,
            workspaceEpoch: startEpoch,
            manifestDigest,
          },
          analysis,
          await compiler.workspaceClosure(path),
          { syncMs, analysisMs: Date.now() - start },
        );
        this.#noteSettled(
          caches.semantic,
          key,
          revision,
          startEpoch,
          path,
          result.dependencies,
          "ok",
        );
        return result;
      } catch (error) {
        const work = { syncMs, analysisMs: Date.now() - start };
        const mapped = diagnosticsFromError(path, error);
        if (mapped === null) {
          caches.semantic.noteSettled(key, revision, {
            revision,
            dependencies: null,
            outcome: "infrastructure-failure",
          });
          throw error;
        }
        const dependencies = await this.#closureAfterSourceFailure(
          path,
          error,
        );
        const result = failedAnalysis(
          {
            uri,
            lifecycle,
            revision,
            workspaceEpoch: startEpoch,
            manifestDigest,
          },
          { diagnostics: mapped },
          dependencies,
          work,
        );
        this.#noteSettled(
          caches.semantic,
          key,
          revision,
          startEpoch,
          path,
          result.dependencies,
          "ok",
        );
        return result;
      }
    })();
    caches.semantic.set(key, source, revision, startEpoch, path, computed);
    return computed;
  }

  async #typedRevision(
    snapshot: DocumentSnapshot,
  ): Promise<CompilerAnalysis | null> {
    try {
      return (await this.#analysisRevision(snapshot)).analysis;
    } catch (error) {
      if (isSourceFailure(error)) return null;
      throw error;
    }
  }

  /**
   * Runs lint detection for one revision and splits it into publishable
   * diagnostics and rewrite-validation candidates. Detection performs zero
   * fix validations; callers validate candidates where they use them.
   */
  async #lintSplit(
    snapshot: DocumentSnapshot,
    parsed: CompilerSyntaxSnapshot,
  ): Promise<
    {
      readonly detected: readonly LintDiagnostic[];
      readonly split: SplitLintDiagnostics;
    }
  > {
    const source = snapshot.document.source;
    const analysis = await this.#typedRevision(snapshot);
    const detected = lintModule(
      parsed.module,
      source,
      parsed.cst,
      DEFAULT_LINT_RULES,
      {
        specializations: analysis?.specializations,
        simplifications: analysis?.simplifications,
        readability: analysis?.readability,
      },
    );
    return { detected, split: splitLintDiagnostics(detected) };
  }

  #syntaxRevision(
    snapshot: DocumentSnapshot,
  ): Promise<CompilerSyntaxSnapshot> {
    const source = snapshot.document.source;
    const caches = this.#cachesFor(snapshot);
    const key = syntaxCacheKey(source, SYNTAX_FRONTEND_ID);
    const cached = caches.syntax.get(
      key,
      source,
      (epoch) => this.#changesSince(epoch),
    );
    if (cached !== undefined) return cached;
    const path = editorPath(snapshot.uri);
    const revision = snapshot.revision;
    const startEpoch = this.#workspaceEpoch;
    const manifest = this.#captureManifest();
    const computed = (async (): Promise<CompilerSyntaxSnapshot> => {
      await this.#syncOverlays(manifest);
      await this.#refreshDiskInputsIfNeeded();
      const compiler = await this.#compiler;
      try {
        const parsed = await compiler.syntaxSnapshot(path, source);
        let dependencies: readonly string[] | null = null;
        try {
          dependencies = await compiler.workspaceClosure(path);
        } catch {
          dependencies = null;
        }
        this.#noteSettled(
          caches.syntax,
          key,
          revision,
          startEpoch,
          path,
          dependencies,
          "ok",
        );
        return parsed;
      } catch (error) {
        if (error instanceof LoadError || error instanceof BlotError) {
          const dependencies = await this.#closureAfterSourceFailure(
            path,
            error,
          );
          this.#noteSettled(
            caches.syntax,
            key,
            revision,
            startEpoch,
            path,
            dependencies,
            "source-failure",
          );
        } else {
          caches.syntax.noteSettled(key, revision, {
            revision,
            dependencies: null,
            outcome: "infrastructure-failure",
          });
        }
        throw error;
      }
    })();
    caches.syntax.set(key, source, revision, startEpoch, path, computed);
    return computed;
  }

  /**
   * Reads the dependency closure behind a source failure. Check-phase
   * failures observed the full graph, so their closure invalidates
   * precisely; load-phase failures never did, so they stay coarse.
   */
  async #closureAfterSourceFailure(
    path: string,
    error: unknown,
  ): Promise<readonly string[] | null> {
    if (!(error instanceof BlotError)) return null;
    try {
      return await (await this.#compiler).workspaceClosure(path);
    } catch {
      return null;
    }
  }

  /**
   * Records one settlement, then drops completions whose closure moved
   * mid-flight so a stale result never serves. The root is pinned by its
   * own bytes (each compiler call sets the root overlay atomically with
   * its load), so only non-root dependency changes drop.
   */
  #noteSettled<Value>(
    cache: DependencyCache<Value>,
    key: string,
    revision: number,
    startEpoch: number,
    root: string,
    dependencies: readonly string[] | null,
    outcome: "ok" | "source-failure",
  ): void {
    cache.noteSettled(key, revision, { revision, dependencies, outcome });
    const changed = this.#changesSince(startEpoch);
    if (changed === null) {
      cache.delete(key, revision);
      return;
    }
    if (dependencies === null) {
      if (changed.size > 0) cache.delete(key, revision);
      return;
    }
    for (const dependency of dependencies) {
      if (dependency !== root && changed.has(dependency)) {
        cache.delete(key, revision);
        return;
      }
    }
  }

  /** Captures one immutable overlay manifest over every open document. */
  #captureManifest(): OverlayManifest {
    return captureOverlayManifest(
      this.#store.snapshots().map((snapshot) => ({
        uri: snapshot.uri,
        path: editorPath(snapshot.uri),
        version: snapshot.version,
        source: snapshot.document.source,
      })),
      this.#workspaceEpoch,
    );
  }

  /**
   * Stages every changed open overlay in one compiler slot before analysis.
   * Staging always reads current store text (never the possibly older
   * captured manifest), so a stale request can never regress a newer
   * overlay, and versions always auto-increment: the analysis calls below
   * advance the same overlay sequence, so explicit LSP versions would fall
   * behind and throw. Returns the measured sync work in milliseconds.
   */
  async #syncOverlays(manifest: OverlayManifest): Promise<number> {
    const pending = diffOverlayManifest(this.#syncedManifest, manifest);
    if (pending.length === 0) return 0;
    const start = Date.now();
    const staged = new Map<string, StagedOverlay>();
    for (const entry of pending) {
      const snapshot = this.#store.snapshot(entry.uri);
      if (snapshot === null) continue;
      staged.set(entry.path, { source: snapshot.document.source });
    }
    if (staged.size > 0) {
      await (await this.#compiler).stageOverlays(staged);
    }
    this.#syncedManifest = manifest;
    return Date.now() - start;
  }

  async #refreshDiskInputsIfNeeded(): Promise<void> {
    if (!this.#diskRefreshPending) return;
    this.#diskRefreshPending = false;
    await (await this.#compiler).refreshDiskInputs();
  }

  /**
   * The one isolated scratch session for speculative fix validation. Fixed
   * source variants must never clobber the service workspace, so every
   * speculative check runs here, seeded with the requesting revision's
   * overlay snapshot, and never rewrites the live semantic session root.
   */
  #scratchSession(): ScratchValidationSession {
    const existing = this.#scratch;
    if (existing !== undefined) return existing;
    const session = new ScratchValidationSession(
      this.#createValidationCompiler,
    );
    this.#scratch = session;
    return session;
  }

  /**
   * Captures the open-document overlays for one request's validations.
   * Callers invoke this synchronously at request entry, so every
   * speculative check in the request shares the entry snapshot instead of
   * re-reading the store mid-request.
   */
  #requestOverlays(): ReadonlyMap<string, StagedOverlay> {
    const overlays = new Map<string, StagedOverlay>();
    for (const open of this.#store.snapshots()) {
      overlays.set(editorPath(open.uri), { source: open.document.source });
    }
    return overlays;
  }

  #noteWorkspaceChange(path: string): void {
    this.#workspaceEpoch += 1;
    this.#epochChanges.push({
      epoch: this.#workspaceEpoch,
      paths: new Set([path]),
    });
    while (this.#epochChanges.length > maximumEpochLog) {
      this.#epochChanges.shift();
    }
  }

  /**
   * Collects the paths changed after one epoch. Returns null when the
   * bounded log no longer reaches the epoch, forcing a recompute instead
   * of a possibly stale hit.
   */
  #changesSince(epoch: number): ReadonlySet<string> | null {
    if (epoch >= this.#workspaceEpoch) return new Set<string>();
    const oldest = this.#epochChanges[0];
    if (oldest === undefined || epoch < oldest.epoch) return null;
    const changed = new Set<string>();
    for (const entry of this.#epochChanges) {
      if (entry.epoch > epoch) {
        for (const path of entry.paths) changed.add(path);
      }
    }
    return changed;
  }

  #requiredSnapshot(uri: string): DocumentSnapshot {
    const snapshot = this.#store.snapshot(uri);
    if (snapshot === null) throw new Error(`document ${uri} is not open`);
    return snapshot;
  }

  #cachesFor(snapshot: DocumentSnapshot): DocumentCaches {
    const cached = this.#caches.get(snapshot.uri);
    if (cached !== undefined && cached.lifecycle === snapshot.lifecycle) {
      return cached;
    }
    const fresh = this.#freshCaches(snapshot.lifecycle);
    this.#caches.set(snapshot.uri, fresh);
    return fresh;
  }

  #freshCaches(lifecycle: number): DocumentCaches {
    return {
      lifecycle,
      syntax: new DependencyCache(maximumCachedContents),
      semantic: new DependencyCache(maximumCachedContents),
    };
  }

  async #importedDefinition(
    importerUri: string,
    workspace: readonly DocumentSnapshot[],
    specifier: string,
    name?: string,
  ): Promise<Location | null> {
    let targetPath: string;
    if (isPackageSpecifier(specifier)) {
      if (name !== undefined) return null;
      try {
        targetPath =
          (await resolvePackageExport(specifier, editorPath(importerUri)))
            .source;
      } catch (error) {
        if (error instanceof PackageArtifactError) return null;
        throw error;
      }
    } else {
      targetPath = resolvePath(specifier, editorPath(importerUri));
    }
    let targetUri = toFileUrl(targetPath).href;
    let targetSource: string | undefined;
    // Open targets resolve against the request-entry workspace snapshot, so
    // navigation never re-reads the store mid-request: the answer always
    // describes the world the request started in.
    for (const open of workspace) {
      if (editorPath(open.uri) !== targetPath) continue;
      targetUri = open.uri;
      targetSource = open.document.source;
      break;
    }
    const openTarget = targetSource !== undefined;
    if (targetSource === undefined) {
      try {
        targetSource = await readFile(targetPath, "utf8");
      } catch (error) {
        if (
          error instanceof Error && "code" in error &&
          (error.code === "ENOENT" || error.code === "ENOTDIR" ||
            error.code === "EISDIR")
        ) {
          return null;
        }
        throw error;
      }
    }
    if (name === undefined) {
      const start = { line: 0, character: 0 };
      return { uri: targetUri, range: { start, end: start } };
    }
    const compiler = await this.#compiler;
    let snapshot: CompilerSyntaxSnapshot;
    try {
      snapshot = await compiler.syntaxSnapshot(targetPath, targetSource);
    } finally {
      if (!openTarget) {
        await compiler.releaseRoot(targetPath);
        await compiler.clearOverlay(targetPath);
      }
    }
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

function truncateInlayHint(label: string): string {
  const segments: string[] = [];
  for (const { segment } of inlayHintSegments.segment(label)) {
    if (segments.length === maximumInlayHintLength) {
      return segments.slice(0, maximumInlayHintLength - 1).join("").trimEnd() +
        "…";
    }
    segments.push(segment);
  }
  return label;
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

function unreachableStatementRemovalSpan(source: string, span: Span): Span {
  const code = sourceCodeSpan(source, span);
  const lineStart = source.lastIndexOf("\n", code.start - 1) + 1;
  let start = code.start;
  if (source.slice(lineStart, code.start).trim().length === 0) {
    start = lineStart;
  }

  let end = code.end;
  const lineEnd = source.indexOf("\n", code.end);
  let contentEnd = lineEnd;
  if (lineEnd < 0) contentEnd = source.length;
  if (/^[ \t\r]*$/.test(source.slice(code.end, contentEnd))) {
    end = contentEnd;
    if (lineEnd >= 0) end += 1;
  }
  return { start, end };
}

function lintLanguageSeverity(severity: LintDiagnostic["severity"]): 2 | 4 {
  if (severity === "warning") return 2;
  return 4;
}

/** Orders eager validation budgets deterministically, independent of input. */
function compareActionCandidates(
  left: LintDiagnostic,
  right: LintDiagnostic,
): number {
  if (left.span.start !== right.span.start) {
    return left.span.start - right.span.start;
  }
  if (left.span.end !== right.span.end) return left.span.end - right.span.end;
  if (left.code !== right.code) {
    if (left.code < right.code) return -1;
    return 1;
  }
  const leftFix = left.fix;
  const rightFix = right.fix;
  if (leftFix === null && rightFix === null) return 0;
  if (leftFix === null) return -1;
  if (rightFix === null) return 1;
  if (leftFix.title === rightFix.title) return 0;
  if (leftFix.title < rightFix.title) return -1;
  return 1;
}

/**
 * Answers a resolve that proved nothing: the same action with no diagnostics
 * and no edits. Stale, vanished, and unproven candidates all settle this
 * way instead of returning edits.
 */
function emptyResolvedAction(
  action: CodeAction,
  uri: string,
  version: number,
): CodeAction {
  return {
    title: action.title,
    kind: action.kind,
    diagnostics: [],
    edit: {
      documentChanges: [{
        textDocument: { uri, version },
        edits: [],
      }],
    },
  };
}

export function deduplicateCodeActions(
  actions: readonly CodeAction[],
): readonly CodeAction[] {
  const unique: CodeAction[] = [];
  const indices = new Map<string, number>();
  for (const action of actions) {
    const key = JSON.stringify([
      action.data,
      action.edit.documentChanges.map((change) => ({
        uri: change.textDocument.uri,
        version: change.textDocument.version,
        edits: change.edits.map((edit) => ({
          range: edit.range,
          newText: edit.newText,
        })),
      })),
    ]);
    const existingIndex = indices.get(key);
    if (existingIndex === undefined) {
      indices.set(key, unique.length);
      unique.push(action);
      continue;
    }

    const existing = unique[existingIndex];
    if (existing === undefined) {
      throw new Error(`code action index ${existingIndex} is missing`);
    }
    const diagnostics = [...existing.diagnostics];
    const diagnosticKeys = new Set(diagnostics.map(languageDiagnosticKey));
    for (const diagnostic of action.diagnostics) {
      const diagnosticKey = languageDiagnosticKey(diagnostic);
      if (diagnosticKeys.has(diagnosticKey)) continue;
      diagnosticKeys.add(diagnosticKey);
      diagnostics.push(diagnostic);
    }
    unique[existingIndex] = { ...existing, diagnostics };
  }
  return unique;
}

function languageDiagnosticKey(diagnostic: LanguageDiagnostic): string {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.range,
    diagnostic.message,
    diagnostic.severity,
  ]);
}

/**
 * Whether a workspace failure names broken source inputs rather than broken
 * machinery: a check diagnostic, an unloadable module, a corrupt package
 * capsule, or a missing filesystem input. Providers degrade on these (empty
 * results, diagnostics) instead of failing the request; anything else is an
 * operational failure the coordinator must settle explicitly.
 */
function isSourceFailure(error: unknown): boolean {
  if (
    error instanceof BlotError || error instanceof LoadError ||
    error instanceof PackageArtifactError
  ) {
    return true;
  }
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR" ||
      error.code === "EISDIR");
}

function diagnosticsFromError(
  path: string,
  error: unknown,
): readonly Diagnostic[] | null {
  if (error instanceof LoadError) {
    if (error.diagnostics.length === 0) return null;
    if (resolve(error.path) === resolve(path)) return error.diagnostics;
    return error.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      message: `${error.path}: ${diagnostic.message}`,
      span: { start: 0, end: 0 },
    }));
  }
  if (!(error instanceof BlotError)) return null;
  if (error.origin !== null && resolve(error.origin.path) !== resolve(path)) {
    return [{
      ...error.diagnostic,
      message: `${error.origin.path}: ${error.diagnostic.message}`,
      span: { start: 0, end: 0 },
    }];
  }
  return [error.diagnostic];
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
