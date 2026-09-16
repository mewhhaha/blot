// The shared worker message loop for Deno and Node entries.
//
// Jobs run strictly serially through one promise chain, so a worker holds at
// most one active job no matter how fast the lane sends, and the semantic
// worker keeps the Compiler single-threaded behind its own serialization.
// Handler answers post back as versioned results; handler throws post back
// as explicit failure results. A job that cannot even be validated gets a
// best-effort failure when its id survived, and silence otherwise: malformed
// jobs are coordinator bugs, and the lane fails loud on what it can see.

import {
  LSP_WORKER_PROTOCOL_VERSION,
  lspWorkerJob,
  workerFailureResult,
  workerSuccess,
} from "./protocol.ts";
import type { LspWorkerJob, LspWorkerResult } from "./protocol.ts";

/** Executes one validated job and returns its plain value. */
export type WorkerHandler = (
  job: LspWorkerJob,
) => Promise<unknown> | unknown;

/** The thread boundary in one direction each. */
export interface WorkerPort {
  postResult(value: unknown): void;
  onJob(receive: (value: unknown) => void): void;
}

/** Runs validated jobs serially until the port dies. */
export function runWorkerLoop(
  port: WorkerPort,
  handle: WorkerHandler,
): void {
  let tail: Promise<void> = Promise.resolve();
  port.onJob((value: unknown) => {
    tail = tail.then(() => runOne(port, handle, value));
  });
}

async function runOne(
  port: WorkerPort,
  handle: WorkerHandler,
  value: unknown,
): Promise<void> {
  try {
    await runOneInner(port, handle, value);
  } catch {
    // The port itself failed; nothing more can be reported on it.
  }
}

async function runOneInner(
  port: WorkerPort,
  handle: WorkerHandler,
  value: unknown,
): Promise<void> {
  let job: LspWorkerJob;
  try {
    job = lspWorkerJob(value);
  } catch (error) {
    const salvage = salvageResult(value, error);
    if (salvage !== undefined) port.postResult(salvage);
    return;
  }
  let result: LspWorkerResult;
  try {
    const produced = await handle(job);
    result = workerSuccess(job, produced);
  } catch (error) {
    result = workerFailureResult(job, error);
  }
  port.postResult(result);
}

function salvageResult(value: unknown, error: unknown): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const job = (value as { job?: unknown }).job;
  if (typeof job !== "number" || !Number.isSafeInteger(job) || job < 0) {
    return undefined;
  }
  let message = String(error);
  if (error instanceof Error) message = error.message;
  return {
    protocol: LSP_WORKER_PROTOCOL_VERSION,
    job,
    ok: false,
    kind: undefined,
    name: "TypeError",
    message,
    code: undefined,
  };
}
