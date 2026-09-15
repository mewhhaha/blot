// Node entry for the semantic worker: the node:worker_threads mirror of the
// Deno semantic entry, and the single Compiler owner in Node worker-backed
// mode. The service boots lazily on the first document or service job.
import { parentPort } from "node:worker_threads";
import { runWorkerLoop, type WorkerPort } from "./loop.ts";
import { type LspWorkerJob, WORKER_READY_MESSAGE } from "./protocol.ts";
import { ServiceExecutor } from "./service_executor.ts";
import { executeSyntaxJob } from "./syntax_jobs.ts";

const channel = parentPort;
if (channel === null) {
  throw new Error("semantic node worker needs a parent port");
}

const port: WorkerPort = {
  postResult: (value: unknown) => channel.postMessage(value),
  onJob: (receive: (value: unknown) => void) => {
    channel.on("message", receive);
  },
};

let executor: ServiceExecutor | undefined = undefined;

runWorkerLoop(port, (job: LspWorkerJob) => {
  if (
    job.kind === "cpu/probe" || job.kind === "syntax/parse-facts" ||
    job.kind === "syntax/format"
  ) {
    return executeSyntaxJob(job);
  }
  if (executor === undefined) executor = new ServiceExecutor();
  return executor.execute(job);
});
channel.postMessage(WORKER_READY_MESSAGE);
