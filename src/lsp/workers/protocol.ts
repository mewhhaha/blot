// Versioned serializable job and result types for LSP workers.
//
// Protocol version 1. Every job and result carries `protocol: 1`; workers
// reject anything else so a stale worker can never misread a newer job. All
// payloads are plain JSON values: strings, numbers, booleans, null, arrays,
// and records. Nothing crossing the boundary carries methods or class
// identity, so results survive structured clone in every runtime.
//
// Job kinds:
//
//   cpu/probe ........... deterministic synchronous CPU burn. Doubles as the
//                         keepalive probe and as the real-work-in-a-worker
//                         test job for every supported runtime.
//   syntax/parse-facts .. Baba frontend facts for one source text. Runs where
//                         no Compiler exists; it never touches semantic state.
//   syntax/format ....... the minimal formatting edit for one source text.
//                         Carries its own text, so the syntax lane formats
//                         without a service replica while analysis blocks the
//                         semantic lane.
//   doc/open ............ replica text sync: full text plus version.
//   doc/change .......... replica text sync: incremental changes plus version.
//   doc/close ........... replica text sync: release one document.
//   service/request ..... one LanguageService operation by method name. Runs
//                         only where the single Compiler owner lives.
//
// Results echo the job id. A failed result carries a serializable name and
// message plus, when the handler threw a JSON-RPC failure, its code, so the
// lane can surface invalid params with the original code instead of masking
// it as an internal error.

import type { ContentChange, Position, Range } from "../../text/document.ts";

/** The only protocol version this server speaks. */
export const LSP_WORKER_PROTOCOL_VERSION = 1;

/** Every job kind the protocol carries. */
export type LspWorkerJobKind =
  | "cpu/probe"
  | "syntax/parse-facts"
  | "syntax/format"
  | "doc/open"
  | "doc/change"
  | "doc/close"
  | "service/request";

/** The kinds a syntax worker offers. It never owns a Compiler. */
export const SYNTAX_WORKER_KINDS: readonly LspWorkerJobKind[] = [
  "cpu/probe",
  "syntax/parse-facts",
  "syntax/format",
];

/** The kinds a semantic worker offers. It owns the one Compiler. */
export const SEMANTIC_WORKER_KINDS: readonly LspWorkerJobKind[] = [
  "cpu/probe",
  "syntax/parse-facts",
  "syntax/format",
  "doc/open",
  "doc/change",
  "doc/close",
  "service/request",
];

interface JobEnvelope {
  readonly protocol: typeof LSP_WORKER_PROTOCOL_VERSION;
  readonly job: number;
  readonly kind: LspWorkerJobKind;
}

/** A unit of worker execution. */
export type LspWorkerJob =
  | (JobEnvelope & {
    readonly kind: "cpu/probe";
    readonly iterations: number;
    readonly seed: number;
  })
  | (JobEnvelope & {
    readonly kind: "syntax/parse-facts";
    readonly uri: string;
    readonly source: string;
  })
  | (JobEnvelope & {
    readonly kind: "syntax/format";
    readonly uri: string;
    readonly source: string;
    readonly params: unknown;
  })
  | (JobEnvelope & {
    readonly kind: "doc/open";
    readonly uri: string;
    readonly source: string;
    readonly version: number;
  })
  | (JobEnvelope & {
    readonly kind: "doc/change";
    readonly uri: string;
    readonly changes: readonly ContentChange[];
    readonly version: number;
  })
  | (JobEnvelope & {
    readonly kind: "doc/close";
    readonly uri: string;
  })
  | (JobEnvelope & {
    readonly kind: "service/request";
    readonly method: string;
    readonly uri: string | null;
    readonly params: unknown;
  });

/** A worker answer. Failed answers stay serializable and explicit. */
export type LspWorkerResult =
  | {
    readonly protocol: typeof LSP_WORKER_PROTOCOL_VERSION;
    readonly job: number;
    readonly ok: true;
    readonly kind: LspWorkerJobKind;
    readonly value: unknown;
  }
  | {
    readonly protocol: typeof LSP_WORKER_PROTOCOL_VERSION;
    readonly job: number;
    readonly ok: false;
    readonly kind: LspWorkerJobKind | undefined;
    readonly name: string;
    readonly message: string;
    readonly code: number | undefined;
  };

/** Builds a successful result for one job. */
export function workerSuccess(
  job: LspWorkerJob,
  value: unknown,
): LspWorkerResult {
  return {
    protocol: LSP_WORKER_PROTOCOL_VERSION,
    job: job.job,
    ok: true,
    kind: job.kind,
    value,
  };
}

/** Builds a failed result for one job from a thrown value. */
export function workerFailureResult(
  job: LspWorkerJob,
  error: unknown,
): LspWorkerResult {
  let name = "Error";
  let message = String(error);
  let code: number | undefined = undefined;
  if (error instanceof Error) {
    name = error.name;
    message = error.message;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const candidate = (error as { code: unknown }).code;
    if (typeof candidate === "number" && Number.isSafeInteger(candidate)) {
      code = candidate;
    }
  }
  return {
    protocol: LSP_WORKER_PROTOCOL_VERSION,
    job: job.job,
    ok: false,
    kind: job.kind,
    name,
    message,
    code,
  };
}

/** Validates one inbound job, throwing TypeError when it is not a job. */
export function lspWorkerJob(value: unknown): LspWorkerJob {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("worker job is not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.protocol !== LSP_WORKER_PROTOCOL_VERSION) {
    throw new TypeError("worker job has an unsupported protocol version");
  }
  if (!isJobIdentity(record.job)) {
    throw new TypeError("worker job has no job identity");
  }
  const job = record.job;
  switch (record.kind) {
    case "cpu/probe": {
      if (!isCount(record.iterations)) {
        throw new TypeError("cpu/probe job has invalid iterations");
      }
      if (
        typeof record.seed !== "number" || !Number.isSafeInteger(record.seed)
      ) {
        throw new TypeError("cpu/probe job has an invalid seed");
      }
      return {
        protocol: LSP_WORKER_PROTOCOL_VERSION,
        job,
        kind: "cpu/probe",
        iterations: record.iterations,
        seed: record.seed,
      };
    }
    case "syntax/parse-facts": {
      if (typeof record.uri !== "string") {
        throw new TypeError("syntax/parse-facts job has an invalid uri");
      }
      if (typeof record.source !== "string") {
        throw new TypeError("syntax/parse-facts job has an invalid source");
      }
      return {
        protocol: LSP_WORKER_PROTOCOL_VERSION,
        job,
        kind: "syntax/parse-facts",
        uri: record.uri,
        source: record.source,
      };
    }
    case "syntax/format": {
      if (typeof record.uri !== "string") {
        throw new TypeError("syntax/format job has an invalid uri");
      }
      if (typeof record.source !== "string") {
        throw new TypeError("syntax/format job has an invalid source");
      }
      if (!("params" in record)) {
        throw new TypeError("syntax/format job is missing params");
      }
      return {
        protocol: LSP_WORKER_PROTOCOL_VERSION,
        job,
        kind: "syntax/format",
        uri: record.uri,
        source: record.source,
        params: record.params,
      };
    }
    case "doc/open": {
      if (typeof record.uri !== "string") {
        throw new TypeError("doc/open job has an invalid uri");
      }
      if (typeof record.source !== "string") {
        throw new TypeError("doc/open job has an invalid source");
      }
      if (!isVersion(record.version)) {
        throw new TypeError("doc/open job has an invalid version");
      }
      return {
        protocol: LSP_WORKER_PROTOCOL_VERSION,
        job,
        kind: "doc/open",
        uri: record.uri,
        source: record.source,
        version: record.version,
      };
    }
    case "doc/change": {
      if (typeof record.uri !== "string") {
        throw new TypeError("doc/change job has an invalid uri");
      }
      if (!Array.isArray(record.changes)) {
        throw new TypeError("doc/change job has invalid changes");
      }
      if (!isVersion(record.version)) {
        throw new TypeError("doc/change job has an invalid version");
      }
      return {
        protocol: LSP_WORKER_PROTOCOL_VERSION,
        job,
        kind: "doc/change",
        uri: record.uri,
        changes: record.changes.map(wireContentChange),
        version: record.version,
      };
    }
    case "doc/close": {
      if (typeof record.uri !== "string") {
        throw new TypeError("doc/close job has an invalid uri");
      }
      return {
        protocol: LSP_WORKER_PROTOCOL_VERSION,
        job,
        kind: "doc/close",
        uri: record.uri,
      };
    }
    case "service/request": {
      if (typeof record.method !== "string" || record.method.length === 0) {
        throw new TypeError("service/request job has an invalid method");
      }
      if (record.uri !== null && typeof record.uri !== "string") {
        throw new TypeError("service/request job has an invalid uri");
      }
      if (!("params" in record)) {
        throw new TypeError("service/request job is missing params");
      }
      return {
        protocol: LSP_WORKER_PROTOCOL_VERSION,
        job,
        kind: "service/request",
        method: record.method,
        uri: record.uri,
        params: record.params,
      };
    }
    default:
      throw new TypeError("worker job has an unknown kind");
  }
}

/** Validates one outbound result, throwing TypeError when it is not one. */
export function lspWorkerResult(value: unknown): LspWorkerResult {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("worker result is not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.protocol !== LSP_WORKER_PROTOCOL_VERSION) {
    throw new TypeError("worker result has an unsupported protocol version");
  }
  if (
    typeof record.job !== "number" || !Number.isSafeInteger(record.job) ||
    record.job < 0
  ) {
    throw new TypeError("worker result has no job identity");
  }
  if (record.ok === true) {
    if (!isJobKind(record.kind)) {
      throw new TypeError("worker result has an unknown kind");
    }
    if (!("value" in record)) {
      throw new TypeError("worker result is missing its value");
    }
    return {
      protocol: LSP_WORKER_PROTOCOL_VERSION,
      job: record.job,
      ok: true,
      kind: record.kind,
      value: record.value,
    };
  }
  if (record.ok === false) {
    if (record.kind !== undefined && !isJobKind(record.kind)) {
      throw new TypeError("worker result has an unknown kind");
    }
    if (typeof record.name !== "string") {
      throw new TypeError("worker result has an invalid name");
    }
    if (typeof record.message !== "string") {
      throw new TypeError("worker result has an invalid message");
    }
    if (
      record.code !== undefined &&
      (typeof record.code !== "number" || !Number.isSafeInteger(record.code))
    ) {
      throw new TypeError("worker result has an invalid code");
    }
    let kind: LspWorkerJobKind | undefined = undefined;
    if (isJobKind(record.kind)) kind = record.kind;
    let code: number | undefined = undefined;
    if (typeof record.code === "number") code = record.code;
    return {
      protocol: LSP_WORKER_PROTOCOL_VERSION,
      job: record.job,
      ok: false,
      kind,
      name: record.name,
      message: record.message,
      code,
    };
  }
  throw new TypeError("worker result is neither ok nor failed");
}

function isJobIdentity(job: unknown): job is number {
  return typeof job === "number" && Number.isSafeInteger(job) && job > 0;
}

function isCount(count: unknown): count is number {
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
}

function isVersion(version: unknown): version is number {
  return typeof version === "number" && Number.isSafeInteger(version);
}

function isJobKind(kind: unknown): kind is LspWorkerJobKind {
  return kind === "cpu/probe" ||
    kind === "syntax/parse-facts" ||
    kind === "syntax/format" ||
    kind === "doc/open" ||
    kind === "doc/change" ||
    kind === "doc/close" ||
    kind === "service/request";
}

function wireContentChange(value: unknown): ContentChange {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("doc/change change is not an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string") {
    throw new TypeError("doc/change change has invalid text");
  }
  const change: {
    range?: Range;
    rangeLength?: number;
    text: string;
  } = { text: record.text };
  if (record.range !== undefined) change.range = wireRange(record.range);
  if (record.rangeLength !== undefined) {
    if (typeof record.rangeLength !== "number") {
      throw new TypeError("doc/change change has an invalid range length");
    }
    change.rangeLength = record.rangeLength;
  }
  return change;
}

function wireRange(value: unknown): Range {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("doc/change range is not an object");
  }
  const record = value as Record<string, unknown>;
  return { start: wirePosition(record.start), end: wirePosition(record.end) };
}

function wirePosition(value: unknown): Position {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("doc/change position is not an object");
  }
  const record = value as Record<string, unknown>;
  if (!isCount(record.line) || !isCount(record.character)) {
    throw new TypeError("doc/change position is invalid");
  }
  return { line: record.line, character: record.character };
}

/** Posted by worker entries once the job loop is installed. Hosts filter it. */
export const WORKER_READY_MESSAGE = {
  protocol: LSP_WORKER_PROTOCOL_VERSION,
  ready: true,
} as const;

/** True for the worker ready sentinel, which is not a result. */
export function isWorkerReady(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.protocol === LSP_WORKER_PROTOCOL_VERSION &&
    record.ready === true;
}
