import { parentPort } from "node:worker_threads";
import { serveWorker } from "../worker_runtime.ts";

if (parentPort === null) {
  throw new Error("Spark worker requires a parent message port");
}
const port = parentPort;
serveWorker({
  postMessage: (message) => port.postMessage(message),
  onMessage(receive) {
    port.on("message", receive);
    return () => {
      port.off("message", receive);
    };
  },
});
