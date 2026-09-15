// The LSP coordinator: lifecycle, immediate text sync, lanes, and shutdown.
//
// runCoordinatorServer replaces the old global workTail chain. Requests flow
// through the registry into the syntax or semantic lane, lanes dispatch one
// active job per worker host, the watchdog bounds formatting, and the
// diagnostics orchestrator keeps one latest job per document. Text sync
// applies immediately in received order: directly against the shared service
// in inline mode, or through priority lane jobs in worker-backed mode.
//
// Every advertised capability behaves as before: the same LanguageService
// answers, the same capabilities are advertised, and response shapes are
// unchanged. What changed is explicitness: client cancels settle
// RequestCancelled, server-observed invalidation settles ContentModified, and
// deadlines, overload, crashes, and backend throws settle documented
// failures instead of hanging or returning silent empty results.

import { LanguageService } from "../language_service.ts";
import type { CodeAction, ContentChange } from "../language_service.ts";
import {
  DIAGNOSTICS_DEBOUNCE_MS,
  DiagnosticsOrchestrator,
} from "./diagnostics.ts";
import { CoordinatorDocuments, type DocumentSnapshot } from "./documents.ts";
import { ErrorCodes } from "./errors.ts";
import type { RequestId } from "./errors.ts";
import type { LspWorkerHost } from "./hosts.ts";
import { InlineLspWorkerHost } from "./inline_host.ts";
import type { InlineHandler } from "./inline_host.ts";
import { FORMAT_DEADLINE_MS, RequestRegistry } from "./requests.ts";
import type { Clock, Settlement } from "./requests.ts";
import { systemClock } from "./requests.ts";
import {
  DEFAULT_MAX_PENDING_PER_LANE,
  DEFAULT_OBSOLETE_GRACE_MS,
  laneForMethod,
  Scheduler,
} from "./scheduler.ts";
import type { LaneName, LaneTask, TraceSink } from "./scheduler.ts";
import {
  FrameReader,
  FrameWriter,
  FramingError,
  framingLimits,
  TruncatedInputError,
} from "./transport.ts";
import type { FramingLimits, InboundMessage } from "./transport.ts";
import {
  LSP_WORKER_PROTOCOL_VERSION,
  SEMANTIC_WORKER_KINDS,
  SYNTAX_WORKER_KINDS,
} from "./workers/protocol.ts";
import type {
  LspWorkerJob,
  LspWorkerJobKind,
  LspWorkerResult,
} from "./workers/protocol.ts";
import { ServiceExecutor } from "./workers/service_executor.ts";
import { executeSyntaxJob } from "./workers/syntax_jobs.ts";

/** The default bound for the shutdown drain. */
export const DEFAULT_SHUTDOWN_DRAIN_MS = 5_000;

export interface LanguageServerOptions {
  readonly clock?: Clock;
  readonly traceSink?: TraceSink;
  readonly framing?: Partial<FramingLimits>;
  readonly syntaxHost?: LspWorkerHost;
  readonly semanticHost?: LspWorkerHost;
  readonly debounceMs?: number;
  readonly formatDeadlineMs?: number;
  readonly obsoleteGraceMs?: number;
  readonly shutdownDrainMs?: number;
  readonly maxPendingPerLane?: number;
}

type ServerLifecycle =
  | "uninitialized"
  | "initializing"
  | "running"
  | "shutting-down"
  | "exited";

interface OpenedDocument {
  readonly uri: string;
  readonly version: number;
  readonly text: string;
}

interface ChangedDocument {
  readonly uri: string;
  readonly version: number;
  readonly contentChanges: readonly ContentChange[];
}

const NOTIFICATION_METHODS: ReadonlySet<string> = new Set([
  "initialized",
  "$/cancelRequest",
  "textDocument/didOpen",
  "textDocument/didChange",
  "textDocument/didSave",
  "textDocument/didClose",
]);

const CAPABILITIES: unknown = {
  capabilities: {
    textDocumentSync: {
      openClose: true,
      change: 2,
      save: { includeText: false },
    },
    definitionProvider: true,
    typeDefinitionProvider: true,
    referencesProvider: true,
    renameProvider: true,
    hoverProvider: true,
    completionProvider: {
      resolveProvider: false,
      triggerCharacters: [".", "#"],
    },
    signatureHelpProvider: {
      triggerCharacters: [" ", "("],
    },
    inlayHintProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    documentFormattingProvider: true,
    codeActionProvider: {
      resolveProvider: true,
      codeActionKinds: [
        "quickfix",
        "refactor.rewrite",
        "source.fixAll.blot",
      ],
    },
  },
  serverInfo: { name: "blot", version: "0.1.0" },
};

/**
 * Runs the language server over framed byte streams until exit or clean end
 * of input. Stdout carries protocol frames only; operational detail flows to
 * the trace sink and to window/logMessage notifications.
 */
export async function runCoordinatorServer(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  options: LanguageServerOptions = {},
): Promise<void> {
  const coordinator = new Coordinator(input, output, options);
  await coordinator.run();
}

/** The coordinator: owns lifecycle, sync, lanes, watchdog, and shutdown. */
export class Coordinator {
  readonly #reader: FrameReader;
  readonly #writer: FrameWriter;
  readonly #clock: Clock;
  readonly #trace: TraceSink | undefined;
  readonly #documents = new CoordinatorDocuments();
  readonly #registry: RequestRegistry;
  readonly #scheduler: Scheduler;
  readonly #diagnostics: DiagnosticsOrchestrator;
  readonly #service: LanguageService | undefined;
  readonly #semanticInline: boolean;
  readonly #formatDeadlineMs: number;
  readonly #drainMs: number;
  #lifecycle: ServerLifecycle = "uninitialized";
  #resolveCodeActionEdits = false;
  #drainPromise: Promise<void> | undefined = undefined;
  #resyncQueued = false;

  constructor(
    input: ReadableStream<Uint8Array>,
    output: WritableStream<Uint8Array>,
    options: LanguageServerOptions = {},
  ) {
    if (options.clock !== undefined) this.#clock = options.clock;
    else this.#clock = systemClock();
    this.#trace = options.traceSink;
    this.#reader = new FrameReader(
      input.getReader(),
      framingLimits(options.framing || {}),
    );
    this.#writer = new FrameWriter(output.getWriter());
    this.#registry = new RequestRegistry(this.#clock, {
      onSettle: (id, settlement) => this.#onSettle(id, settlement),
      onDeadline: (record) => this.#scheduler.noteExpired(record.id),
    });
    let service: LanguageService | undefined = undefined;
    let semanticHost: LspWorkerHost;
    if (options.semanticHost !== undefined) {
      semanticHost = options.semanticHost;
    } else {
      service = new LanguageService();
      semanticHost = inlineHost(
        "semantic",
        new ServiceExecutor(service),
      );
    }
    this.#service = service;
    this.#semanticInline = service !== undefined;
    let syntaxHost: LspWorkerHost;
    if (options.syntaxHost !== undefined) {
      syntaxHost = options.syntaxHost;
    } else if (service !== undefined) {
      syntaxHost = inlineHost("syntax", new ServiceExecutor(service));
    } else {
      syntaxHost = inlineSyntaxOnlyHost();
    }
    this.#scheduler = new Scheduler({
      clock: this.#clock,
      documents: this.#documents,
      registry: this.#registry,
      syntaxHost,
      semanticHost,
      maxPendingPerLane: maxPendingPerLane(options),
      obsoleteGraceMs: obsoleteGraceMs(options),
      onTrace: options.traceSink,
      onLaneReconstructed: (lane) => this.#onLaneReconstructed(lane),
    });
    this.#diagnostics = new DiagnosticsOrchestrator({
      clock: this.#clock,
      documents: this.#documents,
      scheduler: this.#scheduler,
      debounceMs: debounceMs(options),
      onTrace: options.traceSink,
      publish: (uri, version, diagnostics) => {
        void this.#notify("textDocument/publishDiagnostics", {
          uri,
          version,
          diagnostics,
        });
      },
    });
    this.#formatDeadlineMs = formatDeadlineMs(options);
    this.#drainMs = shutdownDrainMs(options);
  }

  /** Reads messages until exit or clean end of input, then cleans up. */
  async run(): Promise<void> {
    this.#emit("server/start", { inline: this.#semanticInline });
    try {
      while (true) {
        let message: InboundMessage | null;
        try {
          message = await this.#reader.read();
        } catch (error) {
          if (error instanceof TruncatedInputError) throw error;
          if (error instanceof FramingError) {
            await this.#reportFraming(error);
            continue;
          }
          throw error;
        }
        if (message === null) return;
        if (message.method === "exit") {
          this.#lifecycle = "exited";
          this.#emit("server/exit", {});
          return;
        }
        try {
          await this.#route(message);
        } catch (error) {
          let text = String(error);
          if (error instanceof Error) text = error.message;
          if (message.id !== undefined) {
            await this.#reject(
              message.id,
              ErrorCodes.InternalError,
              text,
            );
          } else {
            await this.#logMessage(text);
          }
        }
      }
    } finally {
      this.#lifecycle = "exited";
      this.#diagnostics.shutdown();
      await this.#finishDrain();
      this.#scheduler.dispose();
      this.#registry.dispose();
      if (this.#service !== undefined) await this.#service.destroy();
      await this.#writer.flush();
      this.#writer.releaseLock();
      this.#reader.releaseLock();
      this.#emit("server/stop", {});
    }
  }

  async #route(message: InboundMessage): Promise<void> {
    const method = message.method;
    if (method === "initialize") {
      await this.#initialize(message.id, message.params);
      return;
    }
    if (method === "shutdown") {
      await this.#shutdown(message.id);
      return;
    }
    if (method !== undefined && NOTIFICATION_METHODS.has(method)) {
      await this.#handleNotification(method, message.params);
      return;
    }
    if (message.id === undefined) {
      this.#emit("server/drop-notification", { method });
      return;
    }
    await this.#handleRequest(method, message.id, message.params);
  }

  async #handleRequest(
    method: string | undefined,
    id: RequestId,
    params: unknown,
  ): Promise<void> {
    if (method === undefined) {
      await this.#reject(
        id,
        ErrorCodes.MethodNotFound,
        `method ${JSON.stringify(method)} is not supported`,
      );
      return;
    }
    if (this.#lifecycle === "shutting-down" || this.#lifecycle === "exited") {
      await this.#reject(id, ErrorCodes.InvalidRequest, "server has shut down");
      return;
    }
    // Requests run once initialize has arrived: its params carry the only
    // handshake information the server uses, and initialized stays a
    // lifecycle marker rather than a gate.
    if (this.#lifecycle === "uninitialized") {
      await this.#reject(
        id,
        ErrorCodes.ServerNotInitialized,
        "server is not initialized",
      );
      return;
    }
    switch (method) {
      case "textDocument/definition":
      case "textDocument/typeDefinition":
      case "textDocument/hover":
      case "textDocument/completion":
      case "textDocument/signatureHelp":
      case "textDocument/inlayHint":
      case "textDocument/documentSymbol":
      case "textDocument/references":
      case "textDocument/rename":
      case "textDocument/formatting":
      case "textDocument/codeAction":
      case "workspace/symbol":
      case "codeAction/resolve": {
        await this.#routeServiceRequest(method, id, params);
        return;
      }
      default:
        await this.#reject(
          id,
          ErrorCodes.MethodNotFound,
          `method ${JSON.stringify(method)} is not supported`,
        );
    }
  }

  async #routeServiceRequest(
    method: string,
    id: RequestId,
    params: unknown,
  ): Promise<void> {
    const uri = requestUri(method, params);
    if (uri === undefined) {
      await this.#reject(
        id,
        ErrorCodes.InvalidParams,
        `${method} params need a text document uri`,
      );
      return;
    }
    const entry = this.#entryFor(uri);
    let deadline: number | undefined = undefined;
    if (method === "textDocument/formatting") deadline = this.#formatDeadlineMs;
    const accepted = this.#registry.accept(id, method, uri, deadline);
    if (accepted.state === "settled") return;
    const shaped = shapeParams(method, params, this.#resolveCodeActionEdits);
    const task: LaneTask = {
      kind: "service/request",
      requestId: id,
      uri,
      entry,
      priority: false,
      build: (jobId: number): LspWorkerJob => ({
        protocol: LSP_WORKER_PROTOCOL_VERSION,
        job: jobId,
        kind: "service/request",
        method,
        uri,
        params: shaped,
      }),
      settle: (result: LspWorkerResult): void => {
        if (!result.ok) return;
        this.#registry.settle(id, {
          kind: "result",
          value: shapeValue(method, result.value),
        });
      },
      abandon: (settlement: Settlement): void => {
        this.#registry.settle(id, settlement);
      },
    };
    this.#scheduler.enqueue(task, laneForMethod(method));
  }

  async #handleNotification(method: string, params: unknown): Promise<void> {
    switch (method) {
      case "initialized":
        if (this.#lifecycle === "initializing") {
          this.#lifecycle = "running";
          this.#emit("server/running", {});
        }
        return;
      case "$/cancelRequest":
        this.#cancelRequest(params);
        return;
      default:
        break;
    }
    if (
      this.#lifecycle === "shutting-down" || this.#lifecycle === "exited"
    ) {
      return;
    }
    switch (method) {
      case "textDocument/didOpen":
        this.#didOpen(params);
        return;
      case "textDocument/didChange":
        this.#didChange(params);
        return;
      case "textDocument/didSave":
        this.#didSave(params);
        return;
      case "textDocument/didClose":
        await this.#didClose(params);
        return;
      default:
        this.#emit("server/drop-notification", { method });
    }
  }

  async #initialize(id: RequestId | undefined, params: unknown): Promise<void> {
    const capabilities = (params as {
      capabilities?: {
        textDocument?: {
          codeAction?: {
            resolveSupport?: { properties?: readonly string[] };
          };
        };
      };
    } | undefined)?.capabilities?.textDocument?.codeAction?.resolveSupport
      ?.properties?.includes("edit") === true;
    this.#resolveCodeActionEdits = capabilities;
    if (this.#lifecycle === "uninitialized") {
      this.#lifecycle = "initializing";
      this.#emit("server/initializing", {});
    }
    if (id !== undefined) await this.#respond(id, CAPABILITIES);
  }

  async #shutdown(id: RequestId | undefined): Promise<void> {
    if (this.#lifecycle !== "shutting-down") {
      this.#lifecycle = "shutting-down";
      this.#emit("server/shutdown", {});
      this.#diagnostics.shutdown();
      this.#drainPromise = this.#scheduler.drain(this.#drainMs).then(
        () => undefined,
        (error: unknown) => {
          let text = String(error);
          if (error instanceof Error) text = error.message;
          this.#emit("server/drain-error", { detail: text });
        },
      );
    }
    if (id !== undefined) await this.#respond(id, null);
  }

  #cancelRequest(params: unknown): void {
    if (typeof params !== "object" || params === null) return;
    const id = (params as { id?: unknown }).id;
    if (id === undefined) return;
    if (id !== null && typeof id !== "string" && typeof id !== "number") {
      return;
    }
    this.#registry.clientCancel(id);
    this.#scheduler.pump();
  }

  #didOpen(params: unknown): void {
    const opened = asOpenParams(params);
    const entry = this.#documents.open(opened.uri, opened.text, opened.version);
    if (this.#service !== undefined) {
      this.#service.open(opened.uri, opened.text, opened.version);
    } else {
      this.#enqueueDocTask("doc/open", opened.uri, (jobId: number) => ({
        protocol: LSP_WORKER_PROTOCOL_VERSION,
        job: jobId,
        kind: "doc/open",
        uri: opened.uri,
        source: opened.text,
        version: opened.version,
      }));
    }
    this.#diagnostics.noteOpened(opened.uri, entry);
  }

  #didChange(params: unknown): void {
    const change = asChangeParams(params);
    if (change.contentChanges.length === 0) {
      throw new Error(
        `document ${change.uri} changed without content changes`,
      );
    }
    const current = this.#documents.current(change.uri);
    if (current === null) {
      throw new Error(`document ${change.uri} is not open`);
    }
    if (change.version <= current.version) {
      throw new Error(
        `document ${change.uri} version ${change.version} does not follow ${current.version}`,
      );
    }
    if (this.#service !== undefined) {
      this.#service.changeRanges(
        change.uri,
        change.contentChanges,
        change.version,
      );
    } else {
      this.#enqueueDocTask("doc/change", change.uri, (jobId: number) => ({
        protocol: LSP_WORKER_PROTOCOL_VERSION,
        job: jobId,
        kind: "doc/change",
        uri: change.uri,
        changes: change.contentChanges.map((one) => ({
          range: one.range,
          rangeLength: one.rangeLength,
          text: one.text,
        })),
        version: change.version,
      }));
    }
    const entry = this.#documents.change(
      change.uri,
      change.contentChanges,
      change.version,
    );
    this.#registry.invalidateUri(change.uri);
    this.#scheduler.dropUriTasks(change.uri);
    this.#diagnostics.noteChanged(change.uri, entry);
  }

  #didSave(params: unknown): void {
    const uri = notificationUri(params);
    if (uri === undefined) {
      throw new Error("textDocument/didSave params need a text document uri");
    }
    const current = this.#documents.current(uri);
    if (current === null) return;
    this.#diagnostics.noteSaved(uri, current);
  }

  async #didClose(params: unknown): Promise<void> {
    const uri = notificationUri(params);
    if (uri === undefined) {
      throw new Error("textDocument/didClose params need a text document uri");
    }
    this.#documents.close(uri);
    this.#registry.invalidateUri(uri);
    this.#scheduler.dropUriTasks(uri);
    this.#diagnostics.noteClosed(uri);
    if (this.#service !== undefined) {
      await this.#service.close(uri);
    } else {
      this.#enqueueDocTask("doc/close", uri, (jobId: number) => ({
        protocol: LSP_WORKER_PROTOCOL_VERSION,
        job: jobId,
        kind: "doc/close",
        uri,
      }));
    }
    await this.#notify("textDocument/publishDiagnostics", {
      uri,
      diagnostics: [],
    });
  }

  #enqueueDocTask(
    kind: "doc/open" | "doc/change" | "doc/close",
    uri: string,
    build: (jobId: number) => LspWorkerJob,
  ): void {
    const task: LaneTask = {
      kind,
      requestId: undefined,
      uri,
      entry: null,
      priority: true,
      build,
      settle: (): void => {
        this.#emit("server/doc-synced", { kind, uri });
      },
      abandon: (): void => {
        this.#emit("server/doc-abandoned", { kind, uri });
        this.#requestResync(`doc-${kind}-abandoned`);
      },
    };
    this.#scheduler.enqueue(task, "semantic");
  }

  #requestResync(reason: string): void {
    if (this.#semanticInline) return;
    if (this.#lifecycle !== "running") return;
    if (this.#resyncQueued) return;
    this.#resyncQueued = true;
    this.#emit("server/resync", { reason });
    try {
      this.#scheduler.dropQueued(
        (task) => task.kind === "doc/open" || task.kind === "doc/change",
        () => ({ kind: "result", value: null }),
      );
      for (const snapshot of this.#documents.snapshots()) {
        const uri = snapshot.uri;
        const text = snapshot.document.source;
        const version = snapshot.version;
        this.#enqueueDocTask("doc/open", uri, (jobId: number) => ({
          protocol: LSP_WORKER_PROTOCOL_VERSION,
          job: jobId,
          kind: "doc/open",
          uri,
          source: text,
          version,
        }));
      }
    } finally {
      this.#resyncQueued = false;
    }
  }

  #onLaneReconstructed(lane: LaneName): void {
    if (lane !== "semantic") return;
    this.#requestResync("lane-reconstructed");
  }

  #onSettle(id: RequestId, settlement: Settlement): void {
    if (settlement.kind === "result") {
      void this.#respond(id, settlement.value).catch((error: unknown) => {
        this.#emit("server/respond-error", { detail: String(error) });
      });
      return;
    }
    void this.#reject(
      id,
      settlement.error.code,
      settlement.error.message,
      settlement.error.data,
    ).catch((error: unknown) => {
      this.#emit("server/respond-error", { detail: String(error) });
    });
  }

  async #reportFraming(error: FramingError): Promise<void> {
    this.#emit("server/framing", { detail: error.message });
    if (error.responseId !== undefined) {
      await this.#reject(error.responseId, error.code, error.message);
      return;
    }
    await this.#logMessage(error.message);
  }

  async #finishDrain(): Promise<void> {
    if (this.#drainPromise !== undefined) {
      await this.#drainPromise;
      return;
    }
    await this.#scheduler.drain(this.#drainMs);
  }

  #entryFor(uri: string | null): DocumentSnapshot | null {
    if (uri === null) return null;
    return this.#documents.current(uri);
  }

  async #respond(id: RequestId, result: unknown): Promise<void> {
    try {
      await this.#writer.write({ jsonrpc: "2.0", id, result });
    } catch (error) {
      this.#emit("server/write-error", { detail: String(error) });
    }
  }

  async #reject(
    id: RequestId,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    try {
      if (data !== undefined) {
        await this.#writer.write({
          jsonrpc: "2.0",
          id,
          error: { code, message, data },
        });
        return;
      }
      await this.#writer.write({
        jsonrpc: "2.0",
        id,
        error: { code, message },
      });
    } catch (error) {
      this.#emit("server/write-error", { detail: String(error) });
    }
  }

  async #notify(method: string, params: unknown): Promise<void> {
    try {
      await this.#writer.write({ jsonrpc: "2.0", method, params });
    } catch (error) {
      this.#emit("server/write-error", { detail: String(error) });
    }
  }

  async #logMessage(message: string): Promise<void> {
    await this.#notify("window/logMessage", { type: 1, message });
  }

  #emit(kind: string, detail: unknown): void {
    if (this.#trace === undefined) return;
    this.#trace({ at: this.#clock.now(), kind, detail });
  }
}

/** Resolves a numeric option that honors an explicit zero. */
function maxPendingPerLane(options: LanguageServerOptions): number {
  if (options.maxPendingPerLane !== undefined) return options.maxPendingPerLane;
  return DEFAULT_MAX_PENDING_PER_LANE;
}

function obsoleteGraceMs(options: LanguageServerOptions): number {
  if (options.obsoleteGraceMs !== undefined) return options.obsoleteGraceMs;
  return DEFAULT_OBSOLETE_GRACE_MS;
}

function debounceMs(options: LanguageServerOptions): number {
  if (options.debounceMs !== undefined) return options.debounceMs;
  return DIAGNOSTICS_DEBOUNCE_MS;
}

function formatDeadlineMs(options: LanguageServerOptions): number {
  if (options.formatDeadlineMs !== undefined) return options.formatDeadlineMs;
  return FORMAT_DEADLINE_MS;
}

function shutdownDrainMs(options: LanguageServerOptions): number {
  if (options.shutdownDrainMs !== undefined) return options.shutdownDrainMs;
  return DEFAULT_SHUTDOWN_DRAIN_MS;
}

/** Builds an inline host sharing one service executor across all kinds. */
function inlineHost(
  role: LaneName,
  executor: ServiceExecutor,
): InlineLspWorkerHost {
  const handlers = new Map<LspWorkerJobKind, InlineHandler>();
  for (const kind of SEMANTIC_WORKER_KINDS) {
    if (kind === "cpu/probe" || kind === "syntax/parse-facts") {
      handlers.set(kind, executeSyntaxJob);
    } else {
      handlers.set(kind, (job: LspWorkerJob) => executor.execute(job));
    }
  }
  return new InlineLspWorkerHost(role, {
    kinds: new Set<LspWorkerJobKind>(SEMANTIC_WORKER_KINDS),
    handlers,
  });
}

/** Builds a Compiler-free inline syntax host; service work overflows. */
function inlineSyntaxOnlyHost(): InlineLspWorkerHost {
  const handlers = new Map<LspWorkerJobKind, InlineHandler>();
  for (const kind of SYNTAX_WORKER_KINDS) {
    handlers.set(kind, executeSyntaxJob);
  }
  return new InlineLspWorkerHost("syntax", {
    kinds: new Set<LspWorkerJobKind>(SYNTAX_WORKER_KINDS),
    handlers,
  });
}

/**
 * Extracts the routing uri for a request method. Returns undefined when the
 * params cannot name a document; null names a document-less request.
 */
function requestUri(
  method: string,
  params: unknown,
): string | null | undefined {
  if (method === "workspace/symbol") return null;
  if (method === "codeAction/resolve") {
    if (typeof params !== "object" || params === null) return null;
    const data = (params as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) return null;
    const uri = (data as { uri?: unknown }).uri;
    if (typeof uri !== "string") return null;
    return uri;
  }
  if (typeof params !== "object" || params === null) return undefined;
  const document = (params as { textDocument?: unknown }).textDocument;
  if (typeof document !== "object" || document === null) return undefined;
  const uri = (document as { uri?: unknown }).uri;
  if (typeof uri !== "string") return undefined;
  return uri;
}

/** Extracts the document uri from a text sync notification. */
function notificationUri(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const document = (params as { textDocument?: unknown }).textDocument;
  if (typeof document !== "object" || document === null) return undefined;
  const uri = (document as { uri?: unknown }).uri;
  if (typeof uri !== "string") return undefined;
  return uri;
}

/** Shapes request params for the worker, injecting server-side context. */
function shapeParams(
  method: string,
  params: unknown,
  resolveCodeActionEdits: boolean,
): unknown {
  if (method !== "textDocument/codeAction") return params;
  if (typeof params !== "object" || params === null) return params;
  const record = params as Record<string, unknown>;
  const context = record.context;
  if (typeof context === "object" && context !== null) {
    return {
      ...record,
      context: { ...context, resolveEdits: resolveCodeActionEdits },
    };
  }
  return { ...record, context: { resolveEdits: resolveCodeActionEdits } };
}

/** Shapes worker values back into client results. */
function shapeValue(method: string, value: unknown): unknown {
  if (method !== "textDocument/codeAction") return value;
  const actions = value as readonly CodeAction[];
  return actions.map((action) => {
    if (action.data === undefined) return action;
    // An omitted edit tells clients that selection must resolve it.
    return { ...action, edit: undefined };
  });
}

function asOpenParams(params: unknown): OpenedDocument {
  if (typeof params !== "object" || params === null) {
    throw new Error("textDocument/didOpen params need a text document");
  }
  const document = (params as { textDocument?: unknown }).textDocument;
  if (typeof document !== "object" || document === null) {
    throw new Error("textDocument/didOpen params need a text document");
  }
  const record = document as Record<string, unknown>;
  if (typeof record.uri !== "string") {
    throw new Error("textDocument/didOpen params need a uri");
  }
  if (
    typeof record.version !== "number" || !Number.isSafeInteger(record.version)
  ) {
    throw new Error("textDocument/didOpen params need a version");
  }
  if (typeof record.text !== "string") {
    throw new Error("textDocument/didOpen params need text");
  }
  return { uri: record.uri, version: record.version, text: record.text };
}

function asChangeParams(params: unknown): ChangedDocument {
  if (typeof params !== "object" || params === null) {
    throw new Error("textDocument/didChange params need a text document");
  }
  const record = params as Record<string, unknown>;
  const document = record.textDocument;
  if (typeof document !== "object" || document === null) {
    throw new Error("textDocument/didChange params need a text document");
  }
  const identified = document as Record<string, unknown>;
  if (typeof identified.uri !== "string") {
    throw new Error("textDocument/didChange params need a uri");
  }
  if (
    typeof identified.version !== "number" ||
    !Number.isSafeInteger(identified.version)
  ) {
    throw new Error("textDocument/didChange params need a version");
  }
  if (!Array.isArray(record.contentChanges)) {
    throw new Error("textDocument/didChange params need content changes");
  }
  return {
    uri: identified.uri,
    version: identified.version,
    contentChanges: record.contentChanges as readonly ContentChange[],
  };
}
