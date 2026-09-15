// Executes document and service jobs against one LanguageService.
//
// The executor is where the single Compiler owner lives: an inline host
// wraps the server-process service, and a semantic worker thread owns its
// replica. Params are validated per method and malformed params fail with
// InvalidParams (-32602), which the worker boundary carries back with its
// code intact. Service throws stay uncoded, so the lane reports them as
// backend failures exactly like the old server did.

import {
  type CodeAction,
  LanguageService,
  type Position,
  type Range,
} from "../../language_service.ts";
import { ErrorCodes, JsonRpcError } from "../errors.ts";
import type { LspWorkerJob } from "./protocol.ts";
import { paramsObject, requireFormattingOptions } from "./params.ts";

/** Runs doc and service jobs against one LanguageService. */
export class ServiceExecutor {
  readonly #service: LanguageService;

  constructor(service?: LanguageService) {
    if (service !== undefined) this.#service = service;
    else this.#service = new LanguageService();
  }

  /** The wrapped service, for inline shutdown and direct text sync. */
  get service(): LanguageService {
    return this.#service;
  }

  /** Executes one job and returns its plain value. */
  async execute(job: LspWorkerJob): Promise<unknown> {
    switch (job.kind) {
      case "doc/open":
        this.#service.open(job.uri, job.source, job.version);
        return null;
      case "doc/change":
        this.#service.changeRanges(job.uri, job.changes, job.version);
        return null;
      case "doc/close":
        await this.#service.close(job.uri);
        return null;
      case "service/request":
        return await this.#request(job.method, job.uri, job.params);
      default:
        throw new Error(`service executor cannot execute ${job.kind}`);
    }
  }

  async #request(
    method: string,
    uri: string | null,
    params: unknown,
  ): Promise<unknown> {
    switch (method) {
      case "textDocument/definition": {
        const at = paramsObject(params, method);
        return await this.#service.definition(
          requireUri(uri, method),
          requirePosition(at, method),
        );
      }
      case "textDocument/typeDefinition": {
        const at = paramsObject(params, method);
        return await this.#service.typeDefinition(
          requireUri(uri, method),
          requirePosition(at, method),
        );
      }
      case "textDocument/hover": {
        const at = paramsObject(params, method);
        return await this.#service.hover(
          requireUri(uri, method),
          requirePosition(at, method),
        );
      }
      case "textDocument/completion": {
        const at = paramsObject(params, method);
        return await this.#service.completion(
          requireUri(uri, method),
          requirePosition(at, method),
        );
      }
      case "textDocument/signatureHelp": {
        const at = paramsObject(params, method);
        return await this.#service.signatureHelp(
          requireUri(uri, method),
          requirePosition(at, method),
        );
      }
      case "textDocument/inlayHint": {
        const at = paramsObject(params, method);
        return await this.#service.inlayHints(
          requireUri(uri, method),
          optionalRange(at, method),
        );
      }
      case "textDocument/documentSymbol": {
        paramsObject(params, method);
        return await this.#service.documentSymbols(requireUri(uri, method));
      }
      case "textDocument/references": {
        const at = paramsObject(params, method);
        return await this.#service.references(
          requireUri(uri, method),
          requirePosition(at, method),
          requireIncludeDeclaration(at, method),
        );
      }
      case "textDocument/rename": {
        const at = paramsObject(params, method);
        return await this.#service.rename(
          requireUri(uri, method),
          requirePosition(at, method),
          requireNewName(at, method),
        );
      }
      case "workspace/symbol": {
        const at = paramsObject(params, method);
        return await this.#service.workspaceSymbols(requireQuery(at, method));
      }
      case "textDocument/formatting": {
        const at = paramsObject(params, method);
        return await this.#service.formatting(
          requireUri(uri, method),
          requireFormattingOptions(at, method),
        );
      }
      case "textDocument/codeAction": {
        const at = paramsObject(params, method);
        const documentUri = requireUri(uri, method);
        return await this.#service.codeActions(
          documentUri,
          requireRange(at, method),
          requireCodeActionContext(at, method),
        );
      }
      case "codeAction/resolve": {
        const action = paramsObject(params, method);
        return await this.#service.resolveCodeAction(
          action as unknown as CodeAction,
        );
      }
      case "textDocument/diagnostic": {
        paramsObject(params, method);
        return await this.#service.diagnostics(requireUri(uri, method));
      }
      default:
        throw new JsonRpcError(
          ErrorCodes.MethodNotFound,
          `method ${JSON.stringify(method)} is not supported`,
        );
    }
  }
}

function requireUri(uri: string | null, method: string): string {
  if (uri === null) {
    throw new JsonRpcError(
      ErrorCodes.InvalidParams,
      `${method} needs a document uri`,
    );
  }
  return uri;
}

function invalidParams(method: string, what: string): JsonRpcError {
  return new JsonRpcError(
    ErrorCodes.InvalidParams,
    `${method} params need ${what}`,
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function requirePosition(
  params: Record<string, unknown>,
  method: string,
): Position {
  const position = params.position;
  if (typeof position !== "object" || position === null) {
    throw invalidParams(method, "a position");
  }
  const at = position as Record<string, unknown>;
  if (!isNonNegativeInteger(at.line) || !isNonNegativeInteger(at.character)) {
    throw invalidParams(method, "a valid position");
  }
  return { line: at.line, character: at.character };
}

function readPosition(
  value: unknown,
  method: string,
  what: string,
): Position {
  if (typeof value !== "object" || value === null) {
    throw invalidParams(method, what);
  }
  const at = value as Record<string, unknown>;
  if (!isNonNegativeInteger(at.line) || !isNonNegativeInteger(at.character)) {
    throw invalidParams(method, what);
  }
  return { line: at.line, character: at.character };
}

function requireRange(
  params: Record<string, unknown>,
  method: string,
): Range {
  const range = params.range;
  if (typeof range !== "object" || range === null) {
    throw invalidParams(method, "a range");
  }
  const span = range as Record<string, unknown>;
  return {
    start: readPosition(span.start, method, "a valid range start"),
    end: readPosition(span.end, method, "a valid range end"),
  };
}

function optionalRange(
  params: Record<string, unknown>,
  method: string,
): Range | undefined {
  if (params.range === undefined) return undefined;
  return requireRange(params, method);
}

function requireIncludeDeclaration(
  params: Record<string, unknown>,
  method: string,
): boolean {
  const context = params.context;
  if (context === undefined) return true;
  if (typeof context !== "object" || context === null) {
    throw invalidParams(method, "a valid references context");
  }
  const include = (context as Record<string, unknown>).includeDeclaration;
  if (include === undefined) return true;
  if (typeof include !== "boolean") {
    throw invalidParams(method, "a valid references context");
  }
  return include;
}

function requireNewName(
  params: Record<string, unknown>,
  method: string,
): string {
  if (typeof params.newName !== "string" || params.newName.length === 0) {
    throw invalidParams(method, "a new name");
  }
  return params.newName;
}

function requireQuery(
  params: Record<string, unknown>,
  method: string,
): string {
  if (typeof params.query !== "string") {
    throw invalidParams(method, "a query string");
  }
  return params.query;
}

function requireCodeActionContext(
  params: Record<string, unknown>,
  method: string,
): { readonly only?: readonly string[]; readonly resolveEdits?: boolean } {
  const context = params.context;
  if (context === undefined) return {};
  if (typeof context !== "object" || context === null) {
    throw invalidParams(method, "a valid code action context");
  }
  const record = context as Record<string, unknown>;
  let only: readonly string[] | undefined = undefined;
  if (record.only !== undefined) {
    if (
      !Array.isArray(record.only) ||
      !record.only.every((kind) => typeof kind === "string")
    ) {
      throw invalidParams(method, "a valid code action context");
    }
    only = record.only as readonly string[];
  }
  let resolveEdits: boolean | undefined = undefined;
  if (record.resolveEdits !== undefined) {
    if (typeof record.resolveEdits !== "boolean") {
      throw invalidParams(method, "a valid code action context");
    }
    resolveEdits = record.resolveEdits;
  }
  return { only, resolveEdits };
}
