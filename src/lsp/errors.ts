// Shared JSON-RPC failure vocabulary for the Blot language server.
//
// P4 owns the coordinator, scheduler, and worker isolation. Every failure a
// request can observe is constructed here so the settlement table stays in one
// place. The table:
//
//   client cancel ........... RequestCancelled (-32800), no data.
//   server-observed invalidation
//     (change or close between stages) ... ContentModified (-32801), with the
//     uri that moved in data.
//   deadline (formatting, 10s from ingress) ... InternalError (-32603) with
//     data { kind: "deadline", method, deadlineMs }. The 10s budget keeps
//     headroom below the 20s default most clients wait before abandoning a
//     formatting request.
//   resource exhaustion (bounded lane overload, shutdown drain) ...
//     InternalError (-32603) with data { kind: "resource", reason }.
//   worker failure (crash, termination, startup failure) ... InternalError
//     (-32603) with data { kind: "worker", reason }.
//   backend failure (a worker or service threw) ... InternalError (-32603)
//     with data { kind: "backend", detail }. Backend failures are reported to
//     the client; they are never converted into synthetic diagnostics.
//
// A failure response is always explicit. The server never answers a request
// with a silent empty result when the work actually failed.

/** A JSON-RPC request, response, or notification identity. */
export type RequestId = number | string | null;

/** The JSON-RPC and LSP error codes the server can emit. */
export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  RequestCancelled: -32800,
  ContentModified: -32801,
} as const;

/** An error that already knows its JSON-RPC code and optional data. */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data: unknown = undefined) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

/** Builds the failure for a request that outlived its watchdog deadline. */
export function deadlineFailure(
  method: string,
  deadlineMs: number,
): JsonRpcError {
  return new JsonRpcError(
    ErrorCodes.InternalError,
    `${method} exceeded its ${deadlineMs}ms deadline`,
    { kind: "deadline", method, deadlineMs },
  );
}

/** Builds the failure for bounded-overload and shutdown-drain rejections. */
export function resourceFailure(reason: string): JsonRpcError {
  return new JsonRpcError(
    ErrorCodes.InternalError,
    `server resources exhausted: ${reason}`,
    { kind: "resource", reason },
  );
}

/** Builds the failure for a worker crash, termination, or startup failure. */
export function workerFailure(reason: string): JsonRpcError {
  return new JsonRpcError(
    ErrorCodes.InternalError,
    `language worker failed: ${reason}`,
    { kind: "worker", reason },
  );
}

/** Builds the failure for a backend that threw instead of answering. */
export function backendFailure(detail: string): JsonRpcError {
  return new JsonRpcError(
    ErrorCodes.InternalError,
    `backend failure: ${detail}`,
    { kind: "backend", detail },
  );
}

/** Builds the failure for server-observed document invalidation. */
export function contentModifiedFailure(uri: string): JsonRpcError {
  return new JsonRpcError(
    ErrorCodes.ContentModified,
    `document ${uri} changed while the request was running`,
    { uri },
  );
}

/** Builds the failure for an explicit client cancellation. */
export function requestCancelledFailure(): JsonRpcError {
  return new JsonRpcError(
    ErrorCodes.RequestCancelled,
    "request cancelled",
  );
}
