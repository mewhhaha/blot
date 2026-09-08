import { Worker } from "node:worker_threads";
import type { HostScope } from "../resources.ts";
import { WorkerExecutor } from "../worker_executor.ts";
import type { WorkerConnection } from "../worker_protocol.ts";

export function createNodeWorkerExecutor(
  root: HostScope,
  options: { readonly size: number },
): WorkerExecutor {
  let entry = "./spark_worker.js";
  if (import.meta.url.endsWith(".ts")) entry = "./spark_worker.ts";
  return new WorkerExecutor(root, {
    size: options.size,
    createWorker(): WorkerConnection {
      const worker = new Worker(new URL(entry, import.meta.url));
      return {
        postMessage: (message) => worker.postMessage(message),
        onMessage(receive) {
          worker.on("message", receive);
          return () => {
            worker.off("message", receive);
          };
        },
        onError(fail) {
          const exited = (code: number) =>
            fail(new Error(`Spark worker exited with status ${code}`));
          worker.on("error", fail);
          worker.on("exit", exited);
          return () => {
            worker.off("error", fail);
            worker.off("exit", exited);
          };
        },
        async terminate() {
          await worker.terminate();
        },
      };
    },
  });
}
