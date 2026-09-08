import { serveWorker } from "./worker_runtime.ts";

const postMessage = Reflect.get(globalThis, "postMessage");
if (typeof postMessage !== "function") {
  throw new Error("Spark worker requires a worker message port");
}
serveWorker({
  postMessage: (message) => Reflect.apply(postMessage, globalThis, [message]),
  onMessage(receive) {
    const listener = (event: Event) => {
      if (!(event instanceof MessageEvent)) {
        throw new TypeError("worker received a non-message event");
      }
      receive(event.data);
    };
    self.addEventListener("message", listener);
    return () => self.removeEventListener("message", listener);
  },
});
