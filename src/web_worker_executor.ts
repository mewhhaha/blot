import type { HostScope } from "./resources.ts";
import { WorkerExecutor } from "./worker_executor.ts";
import type { WorkerConnection } from "./worker_protocol.ts";

export function createWebWorkerExecutor(
  root: HostScope,
  options: { readonly size: number; readonly workerUrl: URL },
): WorkerExecutor {
  return new WorkerExecutor(root, {
    size: options.size,
    createWorker(): WorkerConnection {
      const worker = new Worker(options.workerUrl, { type: "module" });
      return {
        postMessage: (message) => worker.postMessage(message),
        onMessage(receive) {
          const listener = (event: MessageEvent) => receive(event.data);
          worker.addEventListener("message", listener);
          return () => worker.removeEventListener("message", listener);
        },
        onError(fail) {
          const listener = (event: ErrorEvent) =>
            fail(new Error(event.message));
          worker.addEventListener("error", listener);
          return () => worker.removeEventListener("error", listener);
        },
        terminate() {
          worker.terminate();
          return Promise.resolve();
        },
      };
    },
  });
}
