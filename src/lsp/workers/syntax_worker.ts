// Deno entry for the syntax worker. Compiler-free by construction: it imports
// the syntax jobs only, never the service executor.
import { runWorkerLoop, type WorkerPort } from "./loop.ts";
import { WORKER_READY_MESSAGE } from "./protocol.ts";
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

runWorkerLoop(port, executeSyntaxJob);
scope.postMessage(WORKER_READY_MESSAGE);
