// Node entry for the syntax worker: the node:worker_threads mirror of the
// Deno syntax entry. Compiler-free by construction.
import { parentPort } from "node:worker_threads";
import { runWorkerLoop, type WorkerPort } from "./loop.ts";
import { WORKER_READY_MESSAGE } from "./protocol.ts";
import { executeSyntaxJob } from "./syntax_jobs.ts";

const channel = parentPort;
if (channel === null) {
  throw new Error("syntax node worker needs a parent port");
}

const port: WorkerPort = {
  postResult: (value: unknown) => channel.postMessage(value),
  onJob: (receive: (value: unknown) => void) => {
    channel.on("message", receive);
  },
};

runWorkerLoop(port, executeSyntaxJob);
channel.postMessage(WORKER_READY_MESSAGE);
