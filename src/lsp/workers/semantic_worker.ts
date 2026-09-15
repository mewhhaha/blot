// Deno entry for the semantic worker: the single Compiler owner in
// worker-backed mode. The service boots lazily on the first document or
// service job so worker startup stays fast.
import { runWorkerLoop, type WorkerPort } from "./loop.ts";
import { type LspWorkerJob, WORKER_READY_MESSAGE } from "./protocol.ts";
import { ServiceExecutor } from "./service_executor.ts";
import { executeSyntaxJob } from "./syntax_jobs.ts";

const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(
    type: string,
    listener: (event: { readonly data: unknown }) => void,
  ): void;
};

const port: WorkerPort = {
  postResult: (value: unknown) => scope.postMessage(value),
  onJob: (receive: (value: unknown) => void) => {
    scope.addEventListener("message", (event) => receive(event.data));
  },
};

let executor: ServiceExecutor | undefined = undefined;

runWorkerLoop(port, (job: LspWorkerJob) => {
  if (job.kind === "cpu/probe" || job.kind === "syntax/parse-facts") {
    return executeSyntaxJob(job);
  }
  if (executor === undefined) executor = new ServiceExecutor();
  return executor.execute(job);
});
scope.postMessage(WORKER_READY_MESSAGE);
